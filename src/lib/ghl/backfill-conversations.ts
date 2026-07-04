/**
 * Historical GHL conversation backfill — resumable engine.
 *
 * Sweeps every conversation in the location, attributes each to an LI lead, and
 * imports its full SMS/email history (calls → activities) via the shared
 * ingester. Designed to run in bounded chunks: a cron tick processes up to
 * `maxConversations` and persists a cursor into connector_configs.settings, so
 * the next tick resumes exactly where it left off — the backfill survives days
 * of GHL rate-limited paging without redoing work.
 *
 * Correctness:
 *   • Idempotent — messages dedup on external_id, calls on ghl_message_id, so a
 *     re-run (or an overlap with the go-forward webhook) never doubles up.
 *   • Chronological — each thread's messages are inserted oldest-first so TCPA
 *     opt-out/opt-in settles last-wins.
 *   • Trigger-agnostic — inserts never call the live NOW()-stamping counter
 *     RPCs; instead each chunk ends with the authoritative recompute_* functions
 *     over exactly the leads/conversations it touched.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getContact } from './client'
import type { GhlConfig } from './types'
import { searchHash } from '@/lib/encryption'
import { formatToE164 } from '@/lib/leads/phone'
import {
  getConversationMessages,
  normalizeGhlMessage,
  searchConversations,
  type GhlMessage,
} from './conversations'
import { persistGhlMessage, type IngestLead } from './ingest-message'

const SETTINGS_KEY = 'conversation_backfill'
/** Hard guards against runaway paging. */
const MAX_MESSAGE_PAGES = 200
const MAX_CONVERSATION_PAGES = 500

export type BackfillState = {
  /** last_message_date cursor of the last conversation processed. */
  cursor?: string
  done?: boolean
  /** Cumulative, across chunks — observability only. */
  totals?: { conversations: number; messages: number; calls: number; skipped: number }
}

export type BackfillChunkResult = {
  status: 'ok' | 'skipped'
  conversationsProcessed: number
  messagesInserted: number
  callsLogged: number
  skipped: number
  leadsAffected: number
  /** True when more conversations remain — the cron should tick again. */
  moreRemain: boolean
}

async function readState(supabase: SupabaseClient, organizationId: string): Promise<BackfillState> {
  const { data } = await supabase
    .from('connector_configs')
    .select('settings')
    .eq('organization_id', organizationId)
    .eq('connector_type', 'ghl')
    .maybeSingle()
  const settings = (data?.settings || {}) as Record<string, unknown>
  return (settings[SETTINGS_KEY] as BackfillState) || {}
}

async function writeState(
  supabase: SupabaseClient,
  organizationId: string,
  state: BackfillState,
): Promise<void> {
  const { data } = await supabase
    .from('connector_configs')
    .select('settings')
    .eq('organization_id', organizationId)
    .eq('connector_type', 'ghl')
    .maybeSingle()
  const settings = (data?.settings || {}) as Record<string, unknown>
  await supabase
    .from('connector_configs')
    .update({ settings: { ...settings, [SETTINGS_KEY]: state } })
    .eq('organization_id', organizationId)
    .eq('connector_type', 'ghl')
}

/** Fetch a conversation's entire message history, oldest-first. */
async function fetchThread(config: GhlConfig, conversationId: string): Promise<GhlMessage[]> {
  const collected: GhlMessage[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
    const res = await getConversationMessages(config, conversationId, { lastMessageId: cursor })
    collected.push(...res.messages)
    if (!res.nextLastMessageId) break
    cursor = res.nextLastMessageId
  }
  // GHL returns newest-first; reverse to chronological for correct consent + ordering.
  return collected.reverse()
}

export async function backfillGhlConversations(
  supabase: SupabaseClient,
  organizationId: string,
  config: GhlConfig,
  opts: { maxConversations?: number; log?: (msg: string) => void; dryRun?: boolean } = {},
): Promise<BackfillChunkResult> {
  const maxConversations = opts.maxConversations ?? 200
  const log = opts.log ?? (() => {})
  const dryRun = opts.dryRun ?? false

  // A dry run reads live GHL and reports what WOULD be imported without writing
  // anything (no messages, no consent changes, no cursor) — the safe way to
  // verify the live API shapes before committing patient data to prod.
  const state = dryRun ? {} : await readState(supabase, organizationId)
  if (state.done) {
    return {
      status: 'skipped',
      conversationsProcessed: 0,
      messagesInserted: 0,
      callsLogged: 0,
      skipped: 0,
      leadsAffected: 0,
      moreRemain: false,
    }
  }

  const totals = state.totals ?? { conversations: 0, messages: 0, calls: 0, skipped: 0 }
  const contactCache = new Map<string, IngestLead | null>()
  const conversationCache = new Map<string, string>()
  const affectedLeads = new Set<string>()
  const affectedConversations = new Set<string>()

  let cursor = state.cursor
  let processed = 0
  let inserted = 0
  let calls = 0
  let skipped = 0
  let moreRemain = false

  outer: for (let cp = 0; cp < MAX_CONVERSATION_PAGES; cp++) {
    const page = await searchConversations(config, { startAfterDate: cursor, limit: 100 })
    if (page.conversations.length === 0) {
      cursor = undefined // exhausted
      break
    }

    for (const conv of page.conversations) {
      const lead = await resolveContactLead(supabase, organizationId, config, conv.contactId, contactCache)
      if (lead) {
        const thread = await fetchThread(config, conv.id)
        for (const raw of thread) {
          const normalized = normalizeGhlMessage(raw)
          if (!normalized) {
            skipped += 1
            continue
          }
          if (dryRun) {
            if (normalized.isCall) calls += 1
            else inserted += 1
            affectedLeads.add(lead.id)
            continue
          }
          const result = await persistGhlMessage(supabase, {
            organizationId,
            lead,
            normalized,
            bumpCounters: false,
            conversationCache,
          })
          if (result.status === 'inserted') {
            inserted += 1
            affectedLeads.add(lead.id)
            if (result.conversationId) affectedConversations.add(result.conversationId)
          } else if (result.status === 'call_logged') {
            calls += 1
            affectedLeads.add(lead.id)
          } else {
            skipped += 1
          }
        }
      }

      processed += 1
      const nextCursor = conv.lastMessageDate != null ? String(conv.lastMessageDate) : cursor
      // No-progress guard: identical cursor on a full page would loop forever.
      if (nextCursor === cursor && page.conversations.length >= 100) {
        log('cursor did not advance; stopping to avoid a loop')
        moreRemain = true
        break outer
      }
      cursor = nextCursor

      if (processed >= maxConversations) {
        moreRemain = true
        break outer
      }
    }

    if (!page.nextStartAfterDate) {
      cursor = undefined // last page consumed
      break
    }
  }

  if (dryRun) {
    log(
      `DRY RUN: ${processed} conversations, ${inserted} would-insert messages, ${calls} calls, ` +
        `${affectedLeads.size} leads matched (nothing written, no checkpoint)`,
    )
    return {
      status: 'ok',
      conversationsProcessed: processed,
      messagesInserted: inserted,
      callsLogged: calls,
      skipped,
      leadsAffected: affectedLeads.size,
      moreRemain,
    }
  }

  // ── Authoritative recompute for exactly what this chunk touched ──
  if (affectedConversations.size > 0) {
    await supabase.rpc('recompute_conversation_stats', {
      p_conversation_ids: Array.from(affectedConversations),
    })
  }
  if (affectedLeads.size > 0) {
    await supabase.rpc('recompute_lead_message_stats', {
      p_lead_ids: Array.from(affectedLeads),
    })
  }

  totals.conversations += processed
  totals.messages += inserted
  totals.calls += calls
  totals.skipped += skipped
  await writeState(supabase, organizationId, {
    cursor,
    done: !moreRemain,
    totals,
  })

  log(
    `chunk done: ${processed} conversations, ${inserted} messages, ${calls} calls, ` +
      `${affectedLeads.size} leads (moreRemain=${moreRemain})`,
  )

  return {
    status: 'ok',
    conversationsProcessed: processed,
    messagesInserted: inserted,
    callsLogged: calls,
    skipped,
    leadsAffected: affectedLeads.size,
    moreRemain,
  }
}

/** Resolve (and cache) the LI lead behind a GHL contact; self-heals the key. */
async function resolveContactLead(
  supabase: SupabaseClient,
  organizationId: string,
  config: GhlConfig,
  contactId: string | undefined,
  cache: Map<string, IngestLead | null>,
): Promise<IngestLead | null> {
  if (!contactId) return null
  if (cache.has(contactId)) return cache.get(contactId) ?? null

  const direct = await supabase
    .from('leads')
    .select('id, first_name, last_name')
    .eq('organization_id', organizationId)
    .eq('ghl_contact_id', contactId)
    .limit(1)
    .maybeSingle()
  if (direct.data) {
    cache.set(contactId, direct.data as IngestLead)
    return direct.data as IngestLead
  }

  const contact = await getContact(config, contactId)
  if (!contact) {
    cache.set(contactId, null)
    return null
  }
  const email = contact.email?.trim() || null
  const phone = contact.phone ? formatToE164(contact.phone.trim()) : null
  const emailHash = email ? searchHash(email) : null
  const phoneHash = phone ? searchHash(phone) : null
  if (!emailHash && !phoneHash) {
    cache.set(contactId, null)
    return null
  }
  const orFilter = [
    emailHash ? `email_hash.eq.${emailHash}` : null,
    phoneHash ? `phone_hash.eq.${phoneHash}` : null,
  ]
    .filter(Boolean)
    .join(',')
  const { data: matched } = await supabase
    .from('leads')
    .select('id, first_name, last_name')
    .eq('organization_id', organizationId)
    .or(orFilter)
    .limit(1)
    .maybeSingle()

  if (!matched) {
    cache.set(contactId, null)
    return null
  }
  await supabase.from('leads').update({ ghl_contact_id: contactId }).eq('id', matched.id)
  cache.set(contactId, matched as IngestLead)
  return matched as IngestLead
}
