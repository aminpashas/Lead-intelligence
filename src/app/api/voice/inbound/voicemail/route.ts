/**
 * Inbound voicemail callbacks.
 *
 * Two Twilio callbacks share this route (distinguished by ?kind=):
 *   • <Record> action (default): the caller finished their message —
 *     RecordingUrl/RecordingDuration are on the request. Finalize the
 *     voice_calls row as a received voicemail and thank the caller.
 *   • kind=transcript: Twilio's async transcription — attach the text to the
 *     same row so the voicemail is readable in Conversations/lead history.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { validateTwilioWebhook } from '@/lib/messaging/twilio'
import { sayHangupTwiml, hangupTwiml } from '@/lib/voice/inbound-flow'

function xml(body: string): NextResponse {
  return new NextResponse(body, { headers: { 'Content-Type': 'text/xml' } })
}

export async function POST(req: NextRequest) {
  let params: Record<string, string>
  try {
    const rawBody = await req.text()
    params = Object.fromEntries(new URLSearchParams(rawBody))
    const twilioSignature = req.headers.get('x-twilio-signature')
    if (process.env.TWILIO_AUTH_TOKEN) {
      if (!twilioSignature || !validateTwilioWebhook(twilioSignature, req.url, params)) {
        return new NextResponse('Invalid Twilio signature', { status: 401 })
      }
    } else if (process.env.NODE_ENV === 'production') {
      return new NextResponse('Voice webhook not configured', { status: 500 })
    }
  } catch {
    return new NextResponse('Bad request', { status: 400 })
  }

  const vcId = req.nextUrl.searchParams.get('vc')
  const kind = req.nextUrl.searchParams.get('kind')
  if (!vcId) return xml(hangupTwiml())

  const supabase = createServiceClient()
  const { data: call } = await supabase
    .from('voice_calls')
    .select('id, conversation_id, transcript_summary, metadata')
    .eq('id', vcId)
    .maybeSingle()

  if (!call) {
    console.error('[Voice Voicemail] Unknown voice_calls row:', vcId)
    return xml(hangupTwiml())
  }

  const metadata = (call.metadata as Record<string, unknown>) || {}

  if (kind === 'transcript') {
    // Async transcription — may land before OR after the recording action.
    const text = (params.TranscriptionText || '').trim()
    if (text && params.TranscriptionStatus !== 'failed') {
      const { error } = await supabase
        .from('voice_calls')
        .update({
          transcript: `Voicemail from caller: ${text}`.slice(0, 50000),
          transcript_summary: `Voicemail: ${text.slice(0, 480)}`,
        })
        .eq('id', call.id)
      if (error) console.error('[Voice Voicemail] transcript save failed:', error)
    }
    // Transcription callbacks don't need TwiML — 200 acknowledges receipt.
    return NextResponse.json({ received: true })
  }

  // ── <Record> action: the message was left (or the caller hung up) ──
  const recordingUrl = params.RecordingUrl || ''
  const recordingSeconds = Number(params.RecordingDuration) || 0

  const { error } = await supabase
    .from('voice_calls')
    .update({
      status: 'completed',
      ended_at: new Date().toISOString(),
      // A voicemail's usable length IS the recording length.
      duration_seconds: recordingSeconds,
      recording_url: recordingUrl,
      recording_duration_seconds: recordingSeconds,
      outcome: recordingUrl ? 'voicemail_received' : 'no_answer',
      metadata: { ...metadata, voicemail: true, recording_sid: params.RecordingSid || null },
    })
    .eq('id', call.id)
  if (error) console.error('[Voice Voicemail] finalize failed:', error)

  // Bump the thread so the voicemail surfaces in Conversations as fresh
  // inbound activity the team needs to return.
  if (call.conversation_id) {
    await supabase
      .from('conversations')
      .update({ last_message_at: new Date().toISOString(), status: 'open' })
      .eq('id', call.conversation_id)
  }

  if (!recordingUrl) return xml(hangupTwiml())
  return xml(sayHangupTwiml("Thank you. We've received your message and will get back to you as soon as possible. Goodbye."))
}
