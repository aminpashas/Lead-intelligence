/**
 * GHL conversation LIVE TAIL — the go-forward pull path.
 *
 * WHY THIS EXISTS: LI ingested zero GHL conversations for six days (2026-07-13
 * → 07-19) and nothing noticed. Two independent failures stacked:
 *
 *   1. `backfillGhlConversations` is a ONE-TIME historical import that marks
 *      itself `done` — after which every 5-minute cron tick was a no-op.
 *   2. Go-forward capture depended entirely on GHL's webhook POSTing to
 *      /api/webhooks/ghl/message, which silently stopped firing.
 *
 * With both dead, LI was blind to every SMS, email and DM in GHL — and the
 * failure was invisible, because "no new messages" looks identical to "working
 * fine, quiet day".
 *
 * This module is the fix: a poller that NEVER self-terminates. It is not a
 * backfill and must never grow a `done` flag.
 *
 * HOW IT STAYS CHEAP: it keeps a high-water mark (the newest lastMessageDate it
 * has already ingested) and walks conversations newest-first, stopping at the
 * first one at or below that mark. On a quiet tick it processes zero threads
 * and costs a single search call.
 *
 * OVERLAP IS DELIBERATE: the watermark is rewound by LOOKBACK_MS on each tick so
 * clock skew and late-arriving messages can't slip through a boundary. Re-reading
 * a thread is free — messages dedup on external_id and calls on ghl_message_id.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { GhlConfig } from './types'
import { mapGhlChannel, normalizeGhlMessage, searchConversations, type GhlConversation } from './conversations'
import { persistGhlMessage, type IngestLead } from './ingest-message'
import { fetchThread, resolveContactLead } from './backfill-conversations'
import { createLeadFromSocialDm, isSocialMessage } from './social-lead'

const SETTINGS_KEY_POLL = 'conversation_poll'

/** Rewind the watermark by this much each tick so boundary messages can't slip. */
const LOOKBACK_MS = 15 * 60 * 1000

/** Safety rails — a tick must stay well inside the cron's maxDuration. */
const MAX_PAGES = 10
const DEFAULT_MAX_CONVERSATIONS = 60

export type PollState = {
  /** Newest lastMessageDate (epoch ms) already ingested. */
  watermark?: number
  lastRunAt?: string
  totals?: { ticks: number; conversations: number; messages: number; calls: number; socialLeads: number }
}

export type PollResult = {
  status: 'ok' | 'primed'
  conversationsProcessed: number
  messagesInserted: number
  callsLogged: number
  socialLeadsCreated: number
  skipped: number
  watermark: number
  /** True when the tick hit its conversation cap — more may remain. */
  truncated: boolean
}

function convDate(conv: GhlConversation): number {
  const d =
    typeof conv.lastMessageDate === 'number'
      ? conv.lastMessageDate
      : Date.parse(String(conv.lastMessageDate ?? ''))
  return Number.isFinite(d) ? d : 0
}

function isSocialConversation(conv: GhlConversation): boolean {
  const ch = mapGhlChannel(conv.lastMessageType || conv.type)
  return ch === 'messenger' || ch === 'instagram'
}

async function readPollState(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<PollState> {
  const { data } = await supabase
    .from('connector_configs')
    .select('settings')
    .eq('organization_id', organizationId)
    .eq('connector_type', 'ghl')
    .maybeSingle()
  const settings = (data?.settings || {}) as Record<string, unknown>
  return (settings[SETTINGS_KEY_POLL] as PollState) || {}
}

async function writePollState(
  supabase: SupabaseClient,
  organizationId: string,
  state: PollState,
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
    .update({ settings: { ...settings, [SETTINGS_KEY_POLL]: state } })
    .eq('organization_id', organizationId)
    .eq('connector_type', 'ghl')
}

/**
 * Ingest every conversation whose last message is newer than the watermark.
 *
 * First run "primes": it records the newest date and imports nothing, because
 * history is the backfill's job — priming stops a fresh poller from re-sweeping
 * the entire location. Pass `primeTo` to start the tail at a specific instant.
 */
export async function pollGhlConversations(
  supabase: SupabaseClient,
  organizationId: string,
  config: GhlConfig,
  opts: { maxConversations?: number; log?: (m: string) => void; primeTo?: number } = {},
): Promise<PollResult> {
  const maxConversations = opts.maxConversations ?? DEFAULT_MAX_CONVERSATIONS
  const log = opts.log ?? (() => {})

  const state = await readPollState(supabase, organizationId)
  const totals = state.totals ?? { ticks: 0, conversations: 0, messages: 0, calls: 0, socialLeads: 0 }

  const contactCache = new Map<string, IngestLead | null>()
  const conversationCache = new Map<string, string>()
  const affectedLeads = new Set<string>()
  const affectedConversations = new Set<string>()

  let processed = 0
  let inserted = 0
  let calls = 0
  let skipped = 0
  let socialLeadsCreated = 0
  let newest = state.watermark ?? 0
  let truncated = false

  // ── Prime: no watermark yet → record the newest date, import nothing ──
  if (state.watermark == null) {
    const first = await searchConversations(config, { limit: 1, sort: 'desc' })
    const primed = opts.primeTo ?? (first.conversations.length ? convDate(first.conversations[0]) : Date.now())
    await writePollState(supabase, organizationId, {
      watermark: primed,
      lastRunAt: new Date().toISOString(),
      totals,
    })
    log(`primed watermark at ${new Date(primed).toISOString()} (no import — history is the backfill's job)`)
    return {
      status: 'primed',
      conversationsProcessed: 0,
      messagesInserted: 0,
      callsLogged: 0,
      socialLeadsCreated: 0,
      skipped: 0,
      watermark: primed,
      truncated: false,
    }
  }

  const floor = state.watermark - LOOKBACK_MS
  let cursor: string | undefined

  outer: for (let page = 0; page < MAX_PAGES; page++) {
    const res = await searchConversations(config, { limit: 100, sort: 'desc', startAfterDate: cursor })
    if (!res.conversations.length) break

    for (const conv of res.conversations) {
      const date = convDate(conv)
      // Newest-first: the first conversation at or below the floor means every
      // remaining one is older too. Stop — this is what keeps a tick cheap.
      if (date <= floor) break outer

      if (processed >= maxConversations) {
        truncated = true
        break outer
      }

      try {
        let lead = await resolveContactLead(supabase, organizationId, config, conv.contactId, contactCache)
        const socialCandidate = !lead && isSocialConversation(conv)
        if (!lead && !socialCandidate) {
          processed += 1
          if (date > newest) newest = date
          continue
        }

        const thread = await fetchThread(config, conv.id)

        if (socialCandidate) {
          // A DM thread from a contact LI has never seen becomes a lead. Alert
          // only when THEY wrote to us: an outbound-only thread is our own
          // outreach, and pinging staff about their own message is noise.
          const normalized = thread
            .map(normalizeGhlMessage)
            .filter((n): n is NonNullable<ReturnType<typeof normalizeGhlMessage>> => n != null)
          const firstSocial = normalized.find(isSocialMessage)
          if (firstSocial) {
            const hasInbound = normalized.some((n) => isSocialMessage(n) && n.direction === 'inbound')
            lead = await createLeadFromSocialDm(
              supabase,
              organizationId,
              config,
              conv.contactId ?? null,
              firstSocial,
              { suppressAlert: !hasInbound, caller: 'ghl-poll-social' },
            )
            if (lead) socialLeadsCreated += 1
          }
        }

        if (lead) {
          for (const raw of thread) {
            const n = normalizeGhlMessage(raw)
            if (!n) {
              skipped += 1
              continue
            }
            const r = await persistGhlMessage(supabase, {
              organizationId,
              lead,
              normalized: n,
              // Insert only. Despite being a live tail, this poller ends its run
              // with the same authoritative recompute_* RPCs over exactly the
              // conversations and leads it touched, so per-message counter
              // bumps would double-count on top of that recompute.
              bumpCounters: false,
              conversationCache,
            })
            if (r.status === 'inserted') {
              inserted += 1
              affectedLeads.add(lead.id)
              if (r.conversationId) affectedConversations.add(r.conversationId)
            } else if (r.status === 'call_logged') {
              calls += 1
              affectedLeads.add(lead.id)
            } else {
              skipped += 1
            }
          }
        }
      } catch (err) {
        // One poison-pill conversation must never stall the tail; skip past it.
        log(`conversation ${conv.id} failed: ${err instanceof Error ? err.message : String(err)}`)
      }

      processed += 1
      if (date > newest) newest = date
    }

    if (!res.nextStartAfterDate) break
    cursor = res.nextStartAfterDate
  }

  if (affectedConversations.size > 0) {
    await supabase
      .rpc('recompute_conversation_stats', { p_conversation_ids: Array.from(affectedConversations) })
      .then(() => {}, () => {})
  }
  if (affectedLeads.size > 0) {
    await supabase
      .rpc('recompute_lead_message_stats', { p_lead_ids: Array.from(affectedLeads) })
      .then(() => {}, () => {})
  }

  // NOTE: no `done` flag, by design. This is a tail, not a backfill.
  await writePollState(supabase, organizationId, {
    watermark: Math.max(newest, state.watermark),
    lastRunAt: new Date().toISOString(),
    totals: {
      ticks: totals.ticks + 1,
      conversations: totals.conversations + processed,
      messages: totals.messages + inserted,
      calls: totals.calls + calls,
      socialLeads: totals.socialLeads + socialLeadsCreated,
    },
  })

  log(`tick: ${processed} conversations, +${inserted} messages, +${socialLeadsCreated} social leads`)

  return {
    status: 'ok',
    conversationsProcessed: processed,
    messagesInserted: inserted,
    callsLogged: calls,
    socialLeadsCreated,
    skipped,
    watermark: Math.max(newest, state.watermark),
    truncated,
  }
}
