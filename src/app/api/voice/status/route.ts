/**
 * Twilio status + recording callbacks for browser-placed calls.
 *
 * POST /api/voice/status — fired by the <Number> statusCallback (ringing →
 * answered → completed, with talk duration) and by the <Dial record> recording
 * callback. Both are matched back to the voice_calls row by the parent CallSid we
 * stored in the TwiML route, and update status / duration / recording in place.
 *
 * Staff-chosen outcome is set separately (disposition route), so we never
 * overwrite `outcome` here.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { validateTwilioWebhook } from '@/lib/messaging/twilio'
import { mapTwilioStatus } from '@/lib/voice/twilio-voice'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  const url = new URL(request.url)
  const proto = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host
  const publicUrl = `${proto}://${host}${url.pathname}`

  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [k, v] of form.entries()) params[k] = typeof v === 'string' ? v : ''

  const signature = request.headers.get('x-twilio-signature') || ''
  if (!validateTwilioWebhook(signature, publicUrl, params)) {
    logger.warn('Rejected voice status callback with invalid Twilio signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 403 })
  }

  const supabase = createServiceClient()

  // The row's twilio_call_sid is the PARENT (browser) leg. Child-leg callbacks
  // carry ParentCallSid; the recording callback carries the parent as CallSid.
  const lookupSid = params['ParentCallSid'] || params['CallSid']
  if (!lookupSid) return NextResponse.json({ ok: true })

  const { data: call } = await supabase
    .from('voice_calls')
    .select('id, organization_id, lead_id, status, answered_at, outcome')
    .eq('twilio_call_sid', lookupSid)
    .maybeSingle()

  if (!call) return NextResponse.json({ ok: true })

  // ── Recording callback ──────────────────────────────────────────────────────
  if (params['RecordingUrl']) {
    await supabase
      .from('voice_calls')
      .update({
        recording_url: params['RecordingUrl'],
        recording_duration_seconds: params['RecordingDuration'] ? parseInt(params['RecordingDuration'], 10) : null,
      })
      .eq('id', call.id)
    return NextResponse.json({ ok: true })
  }

  // ── Call-status callback ────────────────────────────────────────────────────
  const status = mapTwilioStatus(params['CallStatus'] || '')
  const update: Record<string, unknown> = { status }

  // First time we see the leg connect, stamp answered_at.
  if ((status === 'in_progress' || status === 'completed') && !call.answered_at) {
    update.answered_at = new Date().toISOString()
  }

  const isTerminal = ['completed', 'busy', 'no_answer', 'failed', 'canceled'].includes(status)
  if (isTerminal) {
    const duration = params['CallDuration'] ? parseInt(params['CallDuration'], 10) : 0
    update.duration_seconds = duration
    update.ended_at = new Date().toISOString()
  }

  await supabase.from('voice_calls').update(update).eq('id', call.id)

  // On completion: timeline activity + touch the lead's last-contacted stamp.
  if (isTerminal) {
    const duration = (update.duration_seconds as number) || 0
    await supabase.from('lead_activities').insert({
      organization_id: call.organization_id,
      lead_id: call.lead_id,
      activity_type: 'voice_call_completed',
      title: `Staff call ${status === 'completed' ? 'completed' : status} (${duration}s)`,
      metadata: { call_id: call.id, duration_seconds: duration, status, call_mode: 'browser' },
    })

    if (status === 'completed' && duration > 0) {
      await supabase
        .from('leads')
        .update({ last_contacted_at: new Date().toISOString() })
        .eq('id', call.lead_id)
    }
  }

  return NextResponse.json({ ok: true })
}
