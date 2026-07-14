/**
 * Surface staff (browser/dialer) phone calls in the Conversations inbox.
 *
 * The AI/campaign voice path (`placeOutboundCallToLead`) opens a voice
 * conversation and drops a message marker so the call shows in the inbox. Staff
 * browser calls historically wrote only `voice_calls` + `lead_activities`, so
 * they were visible on the lead timeline but never in Conversations — a call
 * that went unanswered (or even a 5-minute answered one) simply didn't appear
 * there. This module gives staff calls the same treatment: on the terminal
 * status callback we ensure the lead's voice conversation exists and insert a
 * one-line call marker, letting the `on_message_insert` trigger maintain the
 * inbox ordering / preview / unread counters.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

/** Format talk time the way the inbox preview reads best: "29s" / "3m 05s". */
function formatDuration(seconds: number): string {
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}m ${String(s).padStart(2, '0')}s`
  }
  return `${seconds}s`
}

/**
 * Human-readable one-liner for a completed/terminal staff call. Mirrors the
 * outcome the inbox card should show at a glance.
 */
export function buildStaffCallSummary(
  direction: 'inbound' | 'outbound',
  status: string,
  durationSeconds: number
): string {
  const dir = direction === 'inbound' ? 'Inbound' : 'Outbound'
  switch (status) {
    case 'completed':
      return durationSeconds > 0
        ? `${dir} call — completed · ${formatDuration(durationSeconds)}`
        : `${dir} call — ended`
    case 'no_answer':
      return `${dir} call — no answer`
    case 'busy':
      return `${dir} call — busy`
    case 'failed':
      return `${dir} call — failed`
    case 'canceled':
      return `${dir} call — canceled`
    default:
      return `${dir} call — ${status}`
  }
}

/**
 * Find the lead's active voice conversation, creating one if none exists.
 * Voice is a distinct channel row (a lead with SMS + voice keeps separate
 * conversation rows that the inbox collapses into one card), so we scope to
 * channel='voice' + status='active'. Returns null on any failure — callers
 * treat the thread marker as best-effort and never let it block the webhook.
 */
export async function ensureVoiceConversation(
  supabase: SupabaseClient,
  organizationId: string,
  leadId: string
): Promise<string | null> {
  try {
    const { data: existing } = await supabase
      .from('conversations')
      .select('id')
      .eq('lead_id', leadId)
      .eq('channel', 'voice')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (existing?.id) return existing.id as string

    const { data: created } = await supabase
      .from('conversations')
      .insert({
        organization_id: organizationId,
        lead_id: leadId,
        channel: 'voice',
        status: 'active',
        ai_enabled: false,
        ai_mode: 'off',
      })
      .select('id')
      .single()
    return (created?.id as string) || null
  } catch {
    return null
  }
}

/**
 * Ensure a voice conversation exists for the lead and record a single call
 * marker for a terminal staff call. Idempotent per call: the marker is keyed on
 * `external_id = voiceCallId`, so Twilio's per-leg/retried status callbacks
 * collapse to one inbox entry. Best-effort — logs and returns on any error so
 * the caller's webhook response is never affected.
 */
export async function recordStaffCallThreadMarker(
  supabase: SupabaseClient,
  params: {
    voiceCallId: string
    organizationId: string
    leadId: string
    direction: 'inbound' | 'outbound'
    status: string
    durationSeconds: number
  }
): Promise<void> {
  const { voiceCallId, organizationId, leadId, direction, status, durationSeconds } = params
  try {
    // Idempotency guard: one marker per underlying voice_calls row. Both
    // conference legs and Twilio retries resolve to the same voiceCallId.
    const { data: existing } = await supabase
      .from('messages')
      .select('id')
      .eq('external_id', voiceCallId)
      .eq('channel', 'voice')
      .limit(1)
      .maybeSingle()
    if (existing?.id) return

    const conversationId = await ensureVoiceConversation(supabase, organizationId, leadId)
    if (!conversationId) return

    await supabase.from('messages').insert({
      organization_id: organizationId,
      conversation_id: conversationId,
      lead_id: leadId,
      direction,
      channel: 'voice',
      body: buildStaffCallSummary(direction, status, durationSeconds),
      sender_type: 'user',
      sender_name: 'Staff',
      status: 'sent',
      external_id: voiceCallId,
      ai_generated: false,
      metadata: {
        source: 'staff_call',
        call_mode: 'browser',
        voice_call_id: voiceCallId,
        call_status: status,
        duration_seconds: durationSeconds,
      },
    })
  } catch (err) {
    logger.warn('Failed to record staff-call conversation marker', {
      voiceCallId,
      leadId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Set the inbox marker's body to a caller-supplied summary (e.g. the staff
 * disposition summary, which is richer than the raw Twilio status). Upserts:
 * updates the existing marker in place, or creates the conversation + marker if
 * the disposition fires before the status callback. When the marker already
 * exists, the `on_message_insert` trigger does NOT re-fire on UPDATE, so we also
 * refresh the conversation preview — but only if this marker is still the
 * conversation's newest message, to avoid clobbering a later reply's preview.
 * Best-effort — never throws to the caller.
 */
export async function syncStaffCallThreadMarker(
  supabase: SupabaseClient,
  params: {
    voiceCallId: string
    organizationId: string
    leadId: string
    direction: 'inbound' | 'outbound'
    body: string
  }
): Promise<void> {
  const { voiceCallId, organizationId, leadId, direction, body } = params
  try {
    const { data: existing } = await supabase
      .from('messages')
      .select('id, conversation_id')
      .eq('external_id', voiceCallId)
      .eq('channel', 'voice')
      .limit(1)
      .maybeSingle()

    if (!existing?.id) {
      // No marker yet (disposition beat the status callback) — create it. The
      // insert trigger maintains the preview.
      const conversationId = await ensureVoiceConversation(supabase, organizationId, leadId)
      if (!conversationId) return
      await supabase.from('messages').insert({
        organization_id: organizationId,
        conversation_id: conversationId,
        lead_id: leadId,
        direction,
        channel: 'voice',
        body,
        sender_type: 'user',
        sender_name: 'Staff',
        status: 'sent',
        external_id: voiceCallId,
        ai_generated: false,
        metadata: { source: 'staff_call', call_mode: 'browser', voice_call_id: voiceCallId },
      })
      return
    }

    await supabase.from('messages').update({ body }).eq('id', existing.id)

    // Refresh the conversation preview only when this marker is still the newest
    // message in the thread (UPDATE doesn't fire the preview trigger).
    const { data: newest } = await supabase
      .from('messages')
      .select('id')
      .eq('conversation_id', existing.conversation_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (newest?.id === existing.id) {
      await supabase
        .from('conversations')
        .update({ last_message_preview: body.slice(0, 100), updated_at: new Date().toISOString() })
        .eq('id', existing.conversation_id)
    }
  } catch (err) {
    logger.warn('Failed to sync staff-call conversation marker', {
      voiceCallId,
      leadId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}
