/**
 * Human send-pacing for AI SMS.
 *
 * The autopilot answers a patient the instant the model finishes — a fixed
 * few-second beat, every time. That punctuality is one of the loudest "this is a
 * bot" tells: a real coordinator reads the text, thinks, and types. This module
 * schedules an AI SMS to go out a realistic beat later instead of inline.
 *
 * Flow (mirrors the dion_desk_outbox → forward-desk-outbox drain):
 *   1. enqueueDeferredSms() inserts a row with send_at = now + a length-scaled,
 *      jittered delay.
 *   2. The drain-outbound-sms cron calls drainDeferredSms() every minute, which
 *      sends due rows through the SAME consent-gated sendSMSToLead path and only
 *      then records the message on the thread.
 *
 * Inert unless the org's `sms_human_pacing` flag is ON — see auto-respond.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { getAgentIdForRole } from '@/lib/agents/agent-resolver'
import { getActiveRuleSetStamp } from '@/lib/ai/learning/rule-stamp'
import { createEscalation } from '@/lib/autopilot/escalation'
import { logger } from '@/lib/logger'

const DEFAULT_MIN_MS = 20_000 // never faster than 20s — below this it reads as instant
const DEFAULT_MAX_MS = 90_000 // never slower than 90s — beyond this the patient wonders if anyone's there

/**
 * How long to wait before an AI SMS goes out, modeling a human who reads the
 * patient's text and types a reply. Scales with OUR reply length (longer reply =
 * longer "typing"), plus jitter so sends never fall on a fixed cadence, clamped
 * to a sane window.
 *
 * Pure + injectable rand so it's deterministic under test.
 */
export function computeHumanSendDelayMs(
  body: string,
  opts: { minMs?: number; maxMs?: number; rand?: () => number } = {}
): number {
  const minMs = opts.minMs ?? DEFAULT_MIN_MS
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS
  const rand = opts.rand ?? Math.random

  const chars = body.trim().length
  const typingMs = chars * 180 // ~180ms/char: a relaxed phone-typing pace
  const readBeatMs = 8_000 // a beat to read + think before typing
  // ±35% jitter so two replies of the same length don't share a delay.
  const jitter = 1 + (rand() - 0.5) * 0.7

  const raw = (readBeatMs + typingMs) * jitter
  return Math.round(Math.max(minMs, Math.min(maxMs, raw)))
}

export type EnqueueDeferredSmsParams = {
  organization_id: string
  conversation_id: string
  lead_id: string
  to_contact: string
  body: string
  agent?: string
  action_taken?: string
  confidence?: number
  metadata?: Record<string, unknown>
  /** Override the computed delay (mainly for tests). */
  delayMs?: number
}

/**
 * Enqueue an AI SMS for human-paced delivery. Returns { queued: false } on any
 * failure so the caller can fall back to an inline send — a pacing hiccup must
 * never drop a patient reply.
 */
export async function enqueueDeferredSms(
  supabase: SupabaseClient,
  params: EnqueueDeferredSmsParams
): Promise<{ queued: boolean; id?: string; sendAt?: string }> {
  const delayMs = params.delayMs ?? computeHumanSendDelayMs(params.body)
  const sendAt = new Date(Date.now() + delayMs).toISOString()

  try {
    const { data, error } = await supabase
      .from('pending_outbound_sms')
      .insert({
        organization_id: params.organization_id,
        conversation_id: params.conversation_id,
        lead_id: params.lead_id,
        to_contact: params.to_contact,
        body: params.body,
        agent: params.agent ?? null,
        action_taken: params.action_taken ?? null,
        confidence: params.confidence ?? null,
        metadata: params.metadata ?? {},
        send_at: sendAt,
        status: 'pending',
      })
      .select('id')
      .single()

    if (error || !data) {
      logger.warn('enqueueDeferredSms failed — caller should send inline', {
        conversation_id: params.conversation_id,
        error: error?.message,
      })
      return { queued: false }
    }
    return { queued: true, id: data.id as string, sendAt }
  } catch (err) {
    logger.warn('enqueueDeferredSms threw — caller should send inline', {
      conversation_id: params.conversation_id,
      error: err instanceof Error ? err.message : String(err),
    })
    return { queued: false }
  }
}

type PendingRow = {
  id: string
  organization_id: string
  conversation_id: string
  lead_id: string
  to_contact: string
  body: string
  agent: string | null
  action_taken: string | null
  confidence: number | null
  metadata: Record<string, unknown> | null
}

export type DrainResult = { scanned: number; sent: number; failed: number }

/**
 * Send every due, still-pending queued SMS. Called by the drain-outbound-sms
 * cron with a service-role client (bypasses RLS). Each row is atomically claimed
 * (pending → sending) so overlapping cron runs never double-send.
 */
export async function drainDeferredSms(
  supabase: SupabaseClient,
  opts: { limit?: number } = {}
): Promise<DrainResult> {
  const limit = opts.limit ?? 100
  const nowIso = new Date().toISOString()

  const { data: due, error } = await supabase
    .from('pending_outbound_sms')
    .select('id, organization_id, conversation_id, lead_id, to_contact, body, agent, action_taken, confidence, metadata')
    .eq('status', 'pending')
    .lte('send_at', nowIso)
    .order('send_at', { ascending: true })
    .limit(limit)

  if (error || !due || due.length === 0) {
    return { scanned: 0, sent: 0, failed: 0 }
  }

  let sent = 0
  let failed = 0

  for (const row of due as PendingRow[]) {
    // Claim it: only proceed if THIS run flips pending → sending. A concurrent
    // drain that already claimed it gets zero rows back and skips.
    const { data: claimed } = await supabase
      .from('pending_outbound_sms')
      .update({ status: 'sending', attempts: 1 })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claimed) continue

    try {
      const result = await sendSMSToLead({
        supabase,
        leadId: row.lead_id,
        to: row.to_contact,
        body: row.body,
        caller: 'autopilot.deferred_send',
        aiGenerated: true,
        blockOnReview: true,
      })

      if (!result.sent) {
        // Consent/compliance gate refused at send time — mark failed and escalate
        // the draft so a human can decide, same as the inline path would have.
        await supabase
          .from('pending_outbound_sms')
          .update({ status: 'failed', last_error: result.reason ?? 'send_blocked' })
          .eq('id', row.id)
        await createEscalation(supabase, {
          organization_id: row.organization_id,
          conversation_id: row.conversation_id,
          lead_id: row.lead_id,
          reason: 'compliance_flag',
          ai_notes: `Deferred AI SMS could not be delivered at send time: ${result.reason ?? 'blocked'}.`,
          ai_draft_response: row.body,
          ai_confidence: row.confidence ?? undefined,
          agent_type: (row.agent as 'setter' | 'closer' | undefined) ?? undefined,
        }).catch(() => { /* escalation is best-effort */ })
        failed++
        continue
      }

      // Delivered — record it on the thread exactly like the inline path.
      const [agentId, ruleStamp] = await Promise.all([
        row.agent ? getAgentIdForRole(supabase, row.organization_id, row.agent) : Promise.resolve(null),
        getActiveRuleSetStamp(supabase),
      ])

      await supabase.from('messages').insert({
        organization_id: row.organization_id,
        conversation_id: row.conversation_id,
        lead_id: row.lead_id,
        agent_id: agentId,
        direction: 'outbound',
        channel: 'sms',
        body: row.body,
        sender_type: 'ai',
        status: 'sent',
        external_id: result.sid ?? null,
        ai_generated: true,
        ai_confidence: row.confidence ?? null,
        ai_model: 'claude-sonnet-4-6',
        metadata: {
          ...(row.metadata ?? {}),
          agent: row.agent,
          action_taken: row.action_taken,
          autopilot: true,
          human_paced: true,
          ...(ruleStamp ? { rule_set: ruleStamp } : {}),
        },
      })

      await supabase.rpc('increment_conversation_counters', {
        p_conversation_id: row.conversation_id,
        p_last_message_preview: row.body.substring(0, 100),
      })
      await supabase
        .from('leads')
        .update({ last_contacted_at: new Date().toISOString() })
        .eq('id', row.lead_id)

      await supabase
        .from('pending_outbound_sms')
        .update({ status: 'sent', sent_at: new Date().toISOString(), external_id: result.sid ?? null })
        .eq('id', row.id)
      sent++
    } catch (err) {
      await supabase
        .from('pending_outbound_sms')
        .update({ status: 'failed', last_error: err instanceof Error ? err.message : String(err) })
        .eq('id', row.id)
      logger.error(
        'drainDeferredSms: send threw',
        { id: row.id, conversation_id: row.conversation_id },
        err instanceof Error ? err : undefined
      )
      failed++
    }
  }

  return { scanned: due.length, sent, failed }
}
