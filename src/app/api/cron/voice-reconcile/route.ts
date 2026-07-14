/**
 * Voice reconciler cron — heals voice_calls rows stranded in an active state.
 *
 * A voice_calls row is created at status='ringing'/'initiated' the instant a call
 * starts (see /api/voice/inbound, initiateOutboundCall, and the browser softphone
 * TwiML route). It's finalized when the terminal event arrives:
 *   • Retell AI calls  → POST /api/voice/events
 *   • Twilio softphone → POST /api/voice/status (the <Number> statusCallback)
 * If that callback is never delivered — or its handler errored before writing —
 * the row stays active with ended_at=null forever: the UI reports a phantom "live"
 * call that never clears.
 *
 * This sweep is the safety net: for every active-status row older than the grace
 * window, we ask the source of truth (Retell for AI calls, Twilio for softphone
 * calls) whether the call has actually ended, and finalize the record if so. It is
 * deliberately record-only — it does NOT run the encounter processor or send any
 * post-call SMS/email (that path belongs to the live webhook), so re-running it is
 * always safe and idempotent.
 *
 * Runs every 15 min (see vercel.json).
 */

import { withCron } from '@/lib/cron/with-cron'
import { extractFromTranscript } from '@/lib/ai/encounter-processor'
import { getTwilioRestClient, isTwilioRestConfigured } from '@/lib/messaging/twilio'
import { mapTwilioStatus } from '@/lib/voice/twilio-voice'

export const runtime = 'nodejs'

const RETELL_API_KEY = process.env.RETELL_API_KEY || ''

// Only touch rows at least this old, so a genuinely in-flight call is never
// prematurely finalized (voice calls can run several minutes).
const GRACE_MINUTES = 10
// Retell statuses that mean the call is over and safe to finalize from.
const TERMINAL_RETELL_STATUSES = new Set(['ended', 'error'])
// Our normalized statuses that mean a Twilio leg is over.
const TERMINAL_TWILIO_STATUSES = new Set(['completed', 'busy', 'no_answer', 'failed', 'canceled'])
const ACTIVE_STATUSES = ['initiated', 'ringing', 'in_progress']

type StuckRow = {
  id: string
  retell_call_id: string | null
  twilio_call_sid: string | null
  started_at: string | null
  status: string
}

/** 'finalized' — row closed; 'still_active' — genuinely ongoing; 'skipped' — can't reconcile. */
type Outcome = 'finalized' | 'still_active' | 'skipped'

export const POST = withCron('voice-reconcile', async ({ supabase }) => {
  const retellConfigured = !!RETELL_API_KEY
  const twilioConfigured = isTwilioRestConfigured()
  if (!retellConfigured && !twilioConfigured) {
    return { status: 'skipped', data: { reason: 'no_voice_provider_configured' } }
  }

  // Age the sweep off created_at (always set) rather than started_at (null on some
  // stranded-at-ringing rows), so no phantom is permanently invisible to the sweep.
  const cutoff = new Date(Date.now() - GRACE_MINUTES * 60 * 1000).toISOString()

  const { data: stuck, error } = await supabase
    .from('voice_calls')
    .select('id, retell_call_id, twilio_call_sid, started_at, status')
    .in('status', ACTIVE_STATUSES)
    .is('ended_at', null)
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(100)

  if (error) throw new Error(`stuck-row query failed: ${error.message}`)
  if (!stuck || stuck.length === 0) {
    return { status: 'ok', items: 0, data: { finalized: 0, still_active: 0, skipped: 0, checked: 0 } }
  }

  let finalized = 0
  let stillActive = 0
  let skipped = 0

  for (const row of stuck as StuckRow[]) {
    try {
      let outcome: Outcome
      if (row.retell_call_id && retellConfigured) {
        outcome = await reconcileRetellRow(supabase, row)
      } else if (row.twilio_call_sid && twilioConfigured) {
        outcome = await reconcileTwilioRow(supabase, row)
      } else {
        // No external id we can query (or its provider isn't configured this run) —
        // nothing to reconcile against. The UI freshness bound already hides it.
        outcome = 'skipped'
      }

      if (outcome === 'finalized') finalized++
      else if (outcome === 'still_active') stillActive++
      else skipped++
    } catch (err) {
      console.error('[voice-reconcile] row error', row.id, err)
    }
  }

  return {
    status: 'ok',
    items: finalized,
    data: { checked: stuck.length, finalized, still_active: stillActive, skipped },
  }
})

// Vercel cron triggers issue GET; without this the POST-only route 405s and the
// sweep never runs (the "orphaned at ringing" rows never self-heal).
export const GET = POST

type DbClient = Parameters<Parameters<typeof withCron>[1]>[0]['supabase']

/** Finalize a Retell AI call from Retell's record of truth. */
async function reconcileRetellRow(supabase: DbClient, row: StuckRow): Promise<Outcome> {
  const res = await fetch(`https://api.retellai.com/v2/get-call/${row.retell_call_id}`, {
    headers: { Authorization: `Bearer ${RETELL_API_KEY}` },
  })
  if (!res.ok) {
    console.error('[voice-reconcile] Retell fetch failed', row.retell_call_id, res.status)
    return 'skipped'
  }

  const callData = await res.json()
  const retellStatus = (callData.call_status as string) || ''
  if (!TERMINAL_RETELL_STATUSES.has(retellStatus)) {
    // Genuinely still ongoing / not yet answered — leave it for a later sweep.
    return 'still_active'
  }

  const transcript = (callData.transcript || '') as string
  const callAnalysis = (callData.call_analysis || {}) as Record<string, unknown>
  const callDuration = (callData.call_cost?.total_duration_seconds || 0) as number
  const disconnectionReason = (callData.disconnection_reason || '') as string
  const extracted = extractFromTranscript(transcript)

  const { error: updErr } = await supabase
    .from('voice_calls')
    .update({
      status: 'completed',
      ended_at: callData.end_timestamp
        ? new Date(callData.end_timestamp as number).toISOString()
        : new Date().toISOString(),
      duration_seconds: callDuration,
      recording_url: (callData.recording_url || '') as string,
      transcript: transcript.slice(0, 50000),
      transcript_summary: (callAnalysis.call_summary as string) || null,
      outcome: extracted.appointmentBooked
        ? 'appointment_booked'
        : callAnalysis.call_successful
          ? 'interested'
          : disconnectionReason,
      metadata: {
        call_analysis: callAnalysis,
        extracted_info: extracted,
        disconnection_reason: disconnectionReason,
        reconciled_by_cron: true,
        reconciled_at: new Date().toISOString(),
      },
    })
    .eq('id', row.id)

  if (updErr) {
    console.error('[voice-reconcile] retell update failed', row.id, updErr.message)
    return 'skipped'
  }
  return 'finalized'
}

/**
 * Finalize a Twilio softphone call from Twilio's record of truth. Mirrors the
 * terminal branch of /api/voice/status, but does NOT set `outcome` — that's
 * staff-owned (disposition route) and must not be overwritten by the sweep.
 */
async function reconcileTwilioRow(supabase: DbClient, row: StuckRow): Promise<Outcome> {
  const client = getTwilioRestClient()
  const call = await client.calls(row.twilio_call_sid!).fetch()

  const status = mapTwilioStatus(call.status || '')
  if (!TERMINAL_TWILIO_STATUSES.has(status)) {
    // Still queued/ringing/in-progress on Twilio's side — a later sweep will catch it.
    return 'still_active'
  }

  const duration = call.duration ? parseInt(call.duration, 10) : 0
  const endedAt = call.endTime ? new Date(call.endTime).toISOString() : new Date().toISOString()

  const { error: updErr } = await supabase
    .from('voice_calls')
    .update({
      status,
      ended_at: endedAt,
      duration_seconds: Number.isFinite(duration) ? duration : 0,
      metadata: {
        twilio_status: call.status,
        reconciled_by_cron: true,
        reconciled_at: new Date().toISOString(),
      },
    })
    .eq('id', row.id)

  if (updErr) {
    console.error('[voice-reconcile] twilio update failed', row.id, updErr.message)
    return 'skipped'
  }
  return 'finalized'
}
