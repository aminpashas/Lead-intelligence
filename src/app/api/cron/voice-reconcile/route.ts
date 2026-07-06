/**
 * Voice reconciler cron — heals voice_calls rows stranded in an active state.
 *
 * A voice_calls row is created at status='ringing' the instant a call comes in
 * (see /api/voice/inbound and initiateOutboundCall). It's finalized when Retell
 * POSTs the terminal event to /api/voice/events. If that event is never delivered
 * — or its handler errored before the record was written — the row stays at
 * 'ringing'/ended_at=null forever: the transcript lives on Retell but never lands
 * in our DB, and /api/voice/calls/active reports the row as a phantom "live" call.
 *
 * This sweep is the safety net: for every active-status row older than the grace
 * window, we ask Retell for the truth and finalize the record if the call has
 * actually ended. It is deliberately record-only — it does NOT run the encounter
 * processor or send any post-call SMS/email (that path belongs to the live
 * webhook), so re-running it is always safe and idempotent.
 *
 * Runs every 15 min (see vercel.json).
 */

import { withCron } from '@/lib/cron/with-cron'
import { extractFromTranscript } from '@/lib/ai/encounter-processor'

export const runtime = 'nodejs'

const RETELL_API_KEY = process.env.RETELL_API_KEY || ''

// Only touch rows at least this old, so a genuinely in-flight call is never
// prematurely finalized (Retell calls can run several minutes).
const GRACE_MINUTES = 10
// Retell statuses that mean the call is over and safe to finalize from.
const TERMINAL_RETELL_STATUSES = new Set(['ended', 'error'])
const ACTIVE_STATUSES = ['initiated', 'ringing', 'in_progress']

export const POST = withCron('voice-reconcile', async ({ supabase }) => {
  if (!RETELL_API_KEY) {
    return { status: 'skipped', data: { reason: 'no_retell_api_key' } }
  }

  const cutoff = new Date(Date.now() - GRACE_MINUTES * 60 * 1000).toISOString()

  const { data: stuck, error } = await supabase
    .from('voice_calls')
    .select('id, retell_call_id, started_at, status')
    .in('status', ACTIVE_STATUSES)
    .is('ended_at', null)
    .not('retell_call_id', 'is', null)
    .lt('started_at', cutoff)
    .order('started_at', { ascending: true })
    .limit(100)

  if (error) throw new Error(`stuck-row query failed: ${error.message}`)
  if (!stuck || stuck.length === 0) {
    return { status: 'ok', items: 0, data: { finalized: 0, still_active: 0, checked: 0 } }
  }

  let finalized = 0
  let stillActive = 0

  for (const row of stuck) {
    try {
      const res = await fetch(`https://api.retellai.com/v2/get-call/${row.retell_call_id}`, {
        headers: { Authorization: `Bearer ${RETELL_API_KEY}` },
      })
      if (!res.ok) {
        console.error('[voice-reconcile] Retell fetch failed', row.retell_call_id, res.status)
        continue
      }

      const callData = await res.json()
      const retellStatus = (callData.call_status as string) || ''
      if (!TERMINAL_RETELL_STATUSES.has(retellStatus)) {
        // Genuinely still ongoing / not yet answered — leave it for a later sweep.
        stillActive++
        continue
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
        console.error('[voice-reconcile] update failed', row.id, updErr.message)
        continue
      }
      finalized++
    } catch (err) {
      console.error('[voice-reconcile] row error', row.id, err)
    }
  }

  return {
    status: 'ok',
    items: finalized,
    data: { checked: stuck.length, finalized, still_active: stillActive },
  }
})
