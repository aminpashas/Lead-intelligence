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
  mapGhlChannel,
  normalizeGhlMessage,
  searchConversations,
  type GhlConversation,
  type GhlMessage,
} from './conversations'
import { persistGhlMessage, type IngestLead } from './ingest-message'
import { createLeadFromSocialDm, isNewSocialLead } from './social-lead'

/**
 * Does this conversation look like an FB/IG thread? Read from the conversation
 * envelope so an unmatched contact's thread is only fetched when it could mint
 * a social lead — never for the vast unmatched SMS/email backlog.
 */
function isSocialConversation(conv: GhlConversation): boolean {
  const ch = mapGhlChannel(conv.lastMessageType || conv.type)
  return ch === 'messenger' || ch === 'instagram'
}

/**
 * Two independent passes keep their own checkpoint so they never collide:
 *   • full  (asc, oldest-first)  — the cron's complete historical sweep
 *   • recent (desc, newest-first) — a bounded priority pass that hydrates active
 *     leads first. Idempotency (external_id dedup) means the two overlapping is
 *     harmless — whichever reaches a message first wins, the other skips it.
 */
const SETTINGS_KEY_FULL = 'conversation_backfill'
const SETTINGS_KEY_RECENT = 'conversation_backfill_recent'
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
  /** Leads minted from inbound FB/IG DMs by contacts LI had never seen. */
  socialLeadsCreated: number
  /** True when more conversations remain — the cron should tick again. */
  moreRemain: boolean
}

async function readState(
  supabase: SupabaseClient,
  organizationId: string,
  stateKey: string,
): Promise<BackfillState> {
  const { data } = await supabase
    .from('connector_configs')
    .select('settings')
    .eq('organization_id', organizationId)
    .eq('connector_type', 'ghl')
    .maybeSingle()
  const settings = (data?.settings || {}) as Record<string, unknown>
  return (settings[stateKey] as BackfillState) || {}
}

async function writeState(
  supabase: SupabaseClient,
  organizationId: string,
  stateKey: string,
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
    .update({ settings: { ...settings, [stateKey]: state } })
    .eq('organization_id', organizationId)
    .eq('connector_type', 'ghl')
}

/** Fetch a conversation's entire message history, oldest-first. */
export async function fetchThread(config: GhlConfig, conversationId: string): Promise<GhlMessage[]> {
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
  opts: {
    maxConversations?: number
    log?: (msg: string) => void
    dryRun?: boolean
    /** 'asc' = oldest-first full sweep (default); 'desc' = newest-first priority pass. */
    order?: 'asc' | 'desc'
    /** For the desc pass: stop (mark done) once this many conversations are processed. */
    maxTotal?: number
  } = {},
): Promise<BackfillChunkResult> {
  const maxConversations = opts.maxConversations ?? 200
  const log = opts.log ?? (() => {})
  const dryRun = opts.dryRun ?? false
  const order = opts.order ?? 'asc'
  const stateKey = order === 'desc' ? SETTINGS_KEY_RECENT : SETTINGS_KEY_FULL

  // A dry run reads live GHL and reports what WOULD be imported without writing
  // anything (no messages, no consent changes, no cursor) — the safe way to
  // verify the live API shapes before committing patient data to prod.
  const state = dryRun ? {} : await readState(supabase, organizationId, stateKey)
  if (state.done) {
    return {
      status: 'skipped',
      conversationsProcessed: 0,
      messagesInserted: 0,
      callsLogged: 0,
      skipped: 0,
      leadsAffected: 0,
      socialLeadsCreated: 0,
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
  let socialLeadsCreated = 0
  let moreRemain = false

  outer: for (let cp = 0; cp < MAX_CONVERSATION_PAGES; cp++) {
    const pageStart = cursor
    const page = await searchConversations(config, { startAfterDate: cursor, limit: 100, sort: order })
    if (page.conversations.length === 0) {
      cursor = undefined // exhausted
      break
    }

    for (const conv of page.conversations) {
      // A single conversation that GHL 500s (or any per-conversation failure)
      // must NOT abort the whole sweep — an uncaught throw here escapes before
      // the end-of-chunk writeState, so the cursor never advances and every
      // later run (cron included) re-hits the same poison-pill conversation and
      // fails identically, freezing the backfill forever. Isolate each one:
      // skip on error and let the cursor advance past it.
      try {
        let lead = await resolveContactLead(supabase, organizationId, config, conv.contactId, contactCache)

        // An inbound FB/IG DM from an unknown contact IS the lead event — the
        // sweep must mint it here for the same reason the webhook does (see
        // ghl/social-lead.ts): Meta gives no phone/email, so neither key can
        // ever match and no later bridge lands this person.
        //
        // Gated on the conversation's own type so the unmatched SMS/email
        // backlog (240k+ skipped messages) is never fetched, let alone turned
        // into leads. Social threads are a handful; that is the whole point.
        const socialCandidate = !lead && isSocialConversation(conv)
        if (!lead && !socialCandidate) {
          continue
        }

        const thread = await fetchThread(config, conv.id)

        if (socialCandidate) {
          const firstSocial = thread
            .map(normalizeGhlMessage)
            .find((n): n is NonNullable<typeof n> => n != null && isNewSocialLead(n))
          if (firstSocial) {
            if (dryRun) {
              // Never create or alert on a dry run — just report what would happen.
              socialLeadsCreated += 1
            } else {
              lead = await createLeadFromSocialDm(
                supabase,
                organizationId,
                config,
                conv.contactId ?? null,
                firstSocial,
                { caller: 'ghl-backfill-social' },
              )
              if (lead) socialLeadsCreated += 1
            }
          }
        }

        if (lead) {
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
              // Insert only — this chunk ends with the authoritative
              // recompute_* RPCs, so incrementing here would double-count and
              // stamp NOW() onto the recency fields of year-old history.
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
      } catch (err) {
        skipped += 1
        log(`skip conversation ${conv.id}: ${err instanceof Error ? err.message : String(err)}`)
      }

      processed += 1
      // Per-conversation cursor so a mid-page maxConversations stop resumes exactly.
      if (conv.lastMessageDate != null) cursor = String(conv.lastMessageDate)
      if (processed >= maxConversations) {
        moreRemain = true
        break outer
      }
    }

    // Page-level no-progress guard. Adjacent conversations sharing a
    // lastMessageDate is normal (second-resolution timestamps) and must NOT stop
    // paging — only a FULL page that fails to advance the cursor past the date we
    // requested would loop forever.
    if (!page.nextStartAfterDate) {
      cursor = undefined // short page = last page consumed
      break
    }
    if (page.nextStartAfterDate === pageStart) {
      throw new Error(`GHL conversation cursor stuck at ${pageStart} — pagination not advancing`)
    }
    cursor = page.nextStartAfterDate
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
      socialLeadsCreated,
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

  // The recent (desc) priority pass stops once it has hydrated enough of the
  // newest conversations — the full (asc) sweep owns completeness.
  const reachedCap = order === 'desc' && opts.maxTotal != null && totals.conversations >= opts.maxTotal
  if (reachedCap) moreRemain = false
  await writeState(supabase, organizationId, stateKey, {
    cursor,
    done: !moreRemain,
    totals,
  })

  log(
    `chunk done: ${processed} conversations, ${inserted} messages, ${calls} calls, ` +
      `${affectedLeads.size} leads (moreRemain=${moreRemain}${reachedCap ? ', hit maxTotal' : ''})`,
  )

  return {
    status: 'ok',
    conversationsProcessed: processed,
    messagesInserted: inserted,
    callsLogged: calls,
    skipped,
    leadsAffected: affectedLeads.size,
    socialLeadsCreated,
    moreRemain,
  }
}

/** Resolve (and cache) the LI lead behind a GHL contact; self-heals the key. */
export async function resolveContactLead(
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
