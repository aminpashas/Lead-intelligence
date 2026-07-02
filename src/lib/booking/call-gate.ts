/**
 * Phone-First Booking Gate
 *
 * The phone-first protocol says: no consultation is booked from a text thread
 * alone — a real phone conversation must happen first. This module is the single
 * source of truth for two questions the three booking paths (AI, staff, public)
 * all need to answer:
 *
 *   1. isCallGateEnabled(settings) — is this practice enforcing phone-first?
 *   2. hasQualifyingCall(...)      — has a qualifying phone conversation happened?
 *
 * "Either call type counts": a human-logged call and a completed AI voice call
 * are BOTH rows in `voice_calls`, so we never branch on who made the call — only
 * on whether a real two-way conversation took place.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { VoiceCallOutcome, VoiceCallStatus } from '@/types/database'

export type CallGateSettings = {
  require_call_before_booking?: boolean | null
} | null | undefined

/** Is the phone-first gate turned on for this practice? */
export function isCallGateEnabled(settings: CallGateSettings): boolean {
  return settings?.require_call_before_booking === true
}

/** The minimal shape of a voice_calls row the gate reasons about. */
export type QualifyingCallRow = {
  status: VoiceCallStatus
  outcome: VoiceCallOutcome | null
  duration_seconds: number | null
}

/**
 * Outcomes that unlock booking. Per practice policy the gate requires POSITIVE
 * INTENT — a real conversation where the patient showed interest — not merely
 * that a call connected. A flat `not_interested` does NOT unlock a booking
 * (re-engage first); voicemail / no-answer / wrong number never qualify.
 */
export const QUALIFYING_CALL_OUTCOMES: VoiceCallOutcome[] = [
  'appointment_booked',
  'callback_requested',
  'interested',
]

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS RULE — shape this to match how your practice defines "we talked".
//
// This predicate is the whole point of the gate. The default below says: the
// call is `completed` AND its outcome implies a real conversation happened.
//
// Trade-offs you may want to adjust:
//  • Outcomes: should `not_interested` count? (A conversation happened, but you
//    wouldn't book them.) Should a bare `callback_requested` count? Edit
//    QUALIFYING_CALL_OUTCOMES above.
//  • Minimum duration: an AI call marked `completed` after 4 seconds probably
//    wasn't a real discovery call. But MANUAL logs often have no duration, so a
//    hard floor would wrongly reject them — hence it's off by default.
//
// TODO(you): confirm or refine this predicate — it's a domain decision, not a
// mechanical one. See the note in the assistant message for the trade-offs.
// ─────────────────────────────────────────────────────────────────────────────
export function isQualifyingCall(call: QualifyingCallRow): boolean {
  if (call.status !== 'completed') return false
  if (!call.outcome || !QUALIFYING_CALL_OUTCOMES.includes(call.outcome)) return false
  return true
}

/**
 * Has this lead had a qualifying phone conversation? Checks all of the lead's
 * voice_calls (human-logged or AI) against isQualifyingCall().
 *
 * Fails CLOSED on a query error (returns false) so a lookup failure can never
 * silently wave a booking through the gate.
 */
export async function hasQualifyingCall(
  supabase: SupabaseClient,
  organizationId: string,
  leadId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('voice_calls')
    .select('status, outcome, duration_seconds')
    .eq('organization_id', organizationId)
    .eq('lead_id', leadId)
    .eq('status', 'completed')

  if (error || !data) return false
  return data.some((c) => isQualifyingCall(c as QualifyingCallRow))
}
