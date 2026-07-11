/**
 * Human-Response SLA Takeover (Workstream D3)
 *
 * When the D1 allocation resolver returns owner='hold' (human-first with an
 * SLA), the webhook opens a `message_response_slas` timer here. If a human
 * replies before the deadline, the staff-send routes close it as
 * 'human_responded'. If the deadline passes unanswered, the sla-takeover cron
 * calls `attemptTakeover`, which re-runs `processAutoResponse` with
 * `{ takeover: true }` — every safety gate (stop words, rate limit, medical
 * question, confidence, assist, shadow) still runs; a gate block records the
 * breach instead of force-sending.
 *
 * The table doubles as the first-response metrics store: when allocation says
 * 'ai' and the AI replies immediately, `recordImmediateAiResponse` stamps a
 * terminal 'ai_immediate' row so first-response latency is measurable across
 * BOTH lanes.
 *
 * Every entry point fails soft — an SLA bookkeeping failure must never take a
 * webhook, a staff send, or the cron down with it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { completeTasksForConversation, createHumanTask } from '@/lib/automation/tasks'
import { logger } from '@/lib/logger'

/**
 * Exactly the args `processAutoResponse` needs that cannot be reloaded from
 * the database at takeover time. `lead` / `conversation` rows are deliberately
 * NOT stored — `attemptTakeover` reloads them fresh so the gates (ai_mode,
 * opt-outs, overrides) evaluate against current state, not a snapshot.
 */
export type TakeoverPayload = {
  organization_id: string
  conversation_id: string
  lead_id: string
  inbound_message: string
  channel: 'sms' | 'email'
  sender_contact: string
}

export type SlaStatus =
  | 'pending'
  | 'human_responded'
  | 'ai_takeover'
  | 'ai_immediate'
  | 'cancelled'
  | 'expired'

/** Row of message_response_slas. */
export type MessageResponseSla = {
  id: string
  organization_id: string
  conversation_id: string
  lead_id: string
  inbound_message_id: string | null
  inbound_at: string
  sla_seconds: number
  deadline_at: string
  status: SlaStatus
  first_response_at: string | null
  responder_type: 'human' | 'ai' | null
  sla_met: boolean | null
  takeover_payload: TakeoverPayload | Record<string, never>
  takeover_error: string | null
  metadata: Record<string, unknown>
  created_at: string
}

export type OpenResponseSlaInput = {
  organizationId: string
  conversationId: string
  leadId: string
  inboundMessageId?: string | null
  slaSeconds: number
  takeoverPayload: TakeoverPayload
}

export type TakeoverOutcome = 'taken_over' | 'human_responded' | 'expired'

/** Postgres unique-violation SQLSTATE (the burst-collapse race signal). */
const UNIQUE_VIOLATION = '23505'

const DEFAULT_SLA_SECONDS = 180

// ── Open (hold lane) ─────────────────────────────────────────────────

/**
 * Open (or refresh) the pending SLA timer for a conversation.
 *
 * Burst collapse: if a pending row already exists (the lead texted again
 * before anyone responded), the takeover_payload is refreshed so the eventual
 * AI takeover replies to the LATEST message — but inbound_at/deadline_at are
 * kept, because the clock started at the first unanswered inbound.
 *
 * Returns the row id, or null on failure (fails soft).
 */
export async function openResponseSla(
  supabase: SupabaseClient,
  input: OpenResponseSlaInput
): Promise<string | null> {
  try {
    const existingId = await findPendingSlaId(supabase, input.conversationId)
    if (existingId) {
      await refreshPendingPayload(supabase, existingId, input.takeoverPayload)
      return existingId
    }

    const inboundAt = new Date()
    const slaSeconds = input.slaSeconds > 0 ? input.slaSeconds : DEFAULT_SLA_SECONDS
    const { data, error } = await supabase
      .from('message_response_slas')
      .insert({
        organization_id: input.organizationId,
        conversation_id: input.conversationId,
        lead_id: input.leadId,
        inbound_message_id: input.inboundMessageId ?? null,
        inbound_at: inboundAt.toISOString(),
        sla_seconds: slaSeconds,
        deadline_at: new Date(inboundAt.getTime() + slaSeconds * 1000).toISOString(),
        status: 'pending',
        takeover_payload: input.takeoverPayload,
      })
      .select('id')
      .single()

    if (!error && data) return data.id as string

    // Burst race: someone opened the same pending timer between our select and
    // insert. Refresh the winner's payload instead — the earlier clock stands.
    if (error?.code === UNIQUE_VIOLATION) {
      const winnerId = await findPendingSlaId(supabase, input.conversationId)
      if (winnerId) {
        await refreshPendingPayload(supabase, winnerId, input.takeoverPayload)
        return winnerId
      }
    }

    logger.warn('SLA: failed to open response SLA', {
      conversation_id: input.conversationId,
      error: error?.message,
    })
    return null
  } catch (err) {
    logger.warn('SLA: openResponseSla threw', {
      conversation_id: input.conversationId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

async function findPendingSlaId(
  supabase: SupabaseClient,
  conversationId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('message_response_slas')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('status', 'pending')
    .limit(1)
    .maybeSingle()
  return (data?.id as string) ?? null
}

/** Refresh the payload on a live timer; the original deadline is kept. */
async function refreshPendingPayload(
  supabase: SupabaseClient,
  slaId: string,
  payload: TakeoverPayload
): Promise<void> {
  await supabase
    .from('message_response_slas')
    .update({ takeover_payload: payload })
    .eq('id', slaId)
    .eq('status', 'pending')
}

// ── Close on human reply ─────────────────────────────────────────────

/**
 * A staff member replied on the thread: close the pending timer as
 * 'human_responded' (sla_met = replied before the deadline) and complete the
 * live inbound-reply human task. Fails soft; never blocks the send path.
 */
export async function closeSlaOnHumanReply(
  supabase: SupabaseClient,
  conversationId: string,
  userId?: string | null
): Promise<void> {
  try {
    const { data: row } = await supabase
      .from('message_response_slas')
      .select('id, deadline_at')
      .eq('conversation_id', conversationId)
      .eq('status', 'pending')
      .limit(1)
      .maybeSingle()

    if (row) {
      const now = new Date()
      await supabase
        .from('message_response_slas')
        .update({
          status: 'human_responded',
          first_response_at: now.toISOString(),
          responder_type: 'human',
          sla_met: now.getTime() <= new Date(row.deadline_at as string).getTime(),
        })
        .eq('id', row.id)
        .eq('status', 'pending')
    }

    // Close the D2 inbound task even when no timer was running (owner='human'
    // allocations create a task with no SLA row).
    await completeTasksForConversation(supabase, conversationId, userId ?? null, 'done')
  } catch (err) {
    logger.warn('SLA: closeSlaOnHumanReply failed', {
      conversation_id: conversationId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ── Metrics stamp (AI lane) ──────────────────────────────────────────

/**
 * Allocation said 'ai' and the AI replied immediately: stamp a terminal
 * metrics row so first-response latency covers both lanes. Fire-and-forget —
 * never blocks or fails the send path.
 */
export async function recordImmediateAiResponse(
  supabase: SupabaseClient,
  input: {
    organizationId: string
    conversationId: string
    leadId: string
    inboundMessageId?: string | null
  }
): Promise<void> {
  try {
    const now = new Date()
    const { error } = await supabase.from('message_response_slas').insert({
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      lead_id: input.leadId,
      inbound_message_id: input.inboundMessageId ?? null,
      inbound_at: now.toISOString(),
      sla_seconds: DEFAULT_SLA_SECONDS,
      deadline_at: new Date(now.getTime() + DEFAULT_SLA_SECONDS * 1000).toISOString(),
      status: 'ai_immediate',
      first_response_at: now.toISOString(),
      responder_type: 'ai',
      sla_met: true,
    })
    if (error) {
      logger.warn('SLA: recordImmediateAiResponse insert failed', {
        conversation_id: input.conversationId,
        error: error.message,
      })
    }
  } catch (err) {
    logger.warn('SLA: recordImmediateAiResponse threw', {
      conversation_id: input.conversationId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ── Takeover (cron) ──────────────────────────────────────────────────

/**
 * The deadline passed on a pending timer. In order:
 *   1. Human race check — if a staff reply landed after inbound_at (webhook or
 *      out-of-band), close as 'human_responded' instead of taking over.
 *   2. Reload lead + conversation fresh and re-run processAutoResponse with
 *      { takeover: true } (skips the allocation hold branch; all other gates
 *      run). action 'sent' → 'ai_takeover' (sla_met=false — the human missed).
 *   3. Anything else (gate block / failure / opt-out) → 'expired' with
 *      takeover_error + an 'sla_breach_review' human task: nobody answered the
 *      lead, staff must look.
 *
 * Never throws; per-row failures are recorded on the row.
 */
export async function attemptTakeover(
  supabase: SupabaseClient,
  slaRow: MessageResponseSla
): Promise<TakeoverOutcome> {
  try {
    // 1. Human race: any staff-authored outbound since the inbound closes the
    // timer as human_responded (they were late per the timer's clock only if
    // they replied after deadline — sla_met reflects that).
    const { data: humanReply } = await supabase
      .from('messages')
      .select('id, created_at')
      .eq('conversation_id', slaRow.conversation_id)
      .eq('direction', 'outbound')
      .eq('sender_type', 'user')
      .gt('created_at', slaRow.inbound_at)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (humanReply) {
      const respondedAt = humanReply.created_at as string
      await supabase
        .from('message_response_slas')
        .update({
          status: 'human_responded',
          first_response_at: respondedAt,
          responder_type: 'human',
          sla_met:
            new Date(respondedAt).getTime() <= new Date(slaRow.deadline_at).getTime(),
        })
        .eq('id', slaRow.id)
        .eq('status', 'pending')
      await completeTasksForConversation(supabase, slaRow.conversation_id, null, 'done')
      return 'human_responded'
    }

    // 2. No human reply — the AI takes over. Reload lead/conversation fresh so
    // every gate inside processAutoResponse sees current state.
    const payload = slaRow.takeover_payload as TakeoverPayload
    if (!payload?.inbound_message || !payload?.channel || !payload?.sender_contact) {
      await markExpired(supabase, slaRow, 'takeover_payload_incomplete')
      return 'expired'
    }

    const [{ data: lead }, { data: conversation }] = await Promise.all([
      supabase.from('leads').select('*').eq('id', slaRow.lead_id).single(),
      supabase.from('conversations').select('*').eq('id', slaRow.conversation_id).single(),
    ])
    if (!lead || !conversation) {
      await markExpired(supabase, slaRow, 'lead_or_conversation_missing')
      return 'expired'
    }

    const { processAutoResponse } = await import('@/lib/autopilot/auto-respond')
    const result = await processAutoResponse(
      supabase,
      {
        organization_id: slaRow.organization_id,
        conversation_id: slaRow.conversation_id,
        lead_id: slaRow.lead_id,
        lead: lead as Record<string, unknown>,
        conversation: conversation as Record<string, unknown>,
        inbound_message: payload.inbound_message,
        channel: payload.channel,
        sender_contact: payload.sender_contact,
      },
      { takeover: true }
    )

    if (result.action === 'sent') {
      await supabase
        .from('message_response_slas')
        .update({
          status: 'ai_takeover',
          first_response_at: new Date().toISOString(),
          responder_type: 'ai',
          // The human window elapsed unanswered — the SLA was missed even
          // though the AI covered the lead.
          sla_met: false,
        })
        .eq('id', slaRow.id)
        .eq('status', 'pending')
      await completeTasksForConversation(supabase, slaRow.conversation_id, null, 'taken_by_ai')
      logger.info('SLA: AI took over after human window expired', {
        sla_id: slaRow.id,
        conversation_id: slaRow.conversation_id,
      })
      return 'taken_over'
    }

    // 3. A gate blocked the takeover (escalated/skipped/stopped/rate_limited)
    // — the lead is still unanswered; record the breach and put a human on it.
    await markExpired(supabase, slaRow, `takeover_blocked: ${result.action}${result.reason ? ` (${result.reason})` : ''}`)
    return 'expired'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('SLA: attemptTakeover threw', { sla_id: slaRow.id, error: message })
    await markExpired(supabase, slaRow, `takeover_threw: ${message}`).catch(() => {
      /* fail soft — the row stays pending and is retried next sweep */
    })
    return 'expired'
  }
}

/** Terminal breach: nobody (human or AI) answered — record it and raise a review task. */
async function markExpired(
  supabase: SupabaseClient,
  slaRow: MessageResponseSla,
  takeoverError: string
): Promise<void> {
  await supabase
    .from('message_response_slas')
    .update({ status: 'expired', takeover_error: takeoverError })
    .eq('id', slaRow.id)
    .eq('status', 'pending')

  await createHumanTask(supabase, {
    organization_id: slaRow.organization_id,
    kind: 'sla_breach_review',
    title: 'Response SLA breached — lead still unanswered',
    detail:
      `No human replied within the SLA window and the AI takeover did not send ` +
      `(${takeoverError}). This lead has an unanswered inbound message.`,
    source: 'sla_takeover',
    lead_id: slaRow.lead_id,
    conversation_id: slaRow.conversation_id,
    dedupe_key: `sla_breach:${slaRow.conversation_id}`,
    metadata: {
      sla_id: slaRow.id,
      deadline_at: slaRow.deadline_at,
      takeover_error: takeoverError,
    },
  })
}
