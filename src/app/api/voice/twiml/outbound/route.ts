/**
 * TwiML for a browser-placed outbound call.
 *
 * POST /api/voice/twiml/outbound — Twilio fetches this when a staff `Device`
 * places a call (the TwiML App's voice URL points here). It is PUBLIC (Twilio has
 * no user session), so it is defended two ways:
 *
 *   1. X-Twilio-Signature validation — proves the request is really from Twilio.
 *   2. A one-time `dialToken` param (minted by the authenticated /api/voice/prepare,
 *      which already ran the compliance gate) — proves WHICH lead may be dialed.
 *
 * We never trust a raw "To" from the client; the number dialed comes only from the
 * prepared call row the token resolves to.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { validateTwilioWebhook } from '@/lib/messaging/twilio'
import { buildAgentConferenceTwiml, dialLeadIntoConference } from '@/lib/voice/twilio-voice'
import { logger } from '@/lib/logger'

/** A spoken decline + hangup, returned when we can't authorize the dial. */
function declineTwiml(message: string): NextResponse {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${message}</Say><Hangup/></Response>`
  return new NextResponse(xml, { status: 200, headers: { 'Content-Type': 'text/xml' } })
}

export async function POST(request: NextRequest) {
  // Reconstruct the exact public URL Twilio signed (host from the proxy headers).
  // Include the query string: the bridge (ring-my-phone) path passes the dial
  // token as ?dialToken=… on the voice URL, and Twilio signs the full URL. The
  // browser path has no query, so this is a no-op there.
  const url = new URL(request.url)
  const proto = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host
  const publicUrl = `${proto}://${host}${url.pathname}${url.search}`
  const origin = `${proto}://${host}`

  // Parse the form body into a plain param map (Twilio signs these).
  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [k, v] of form.entries()) params[k] = typeof v === 'string' ? v : ''

  // 1. Verify it's really Twilio.
  const signature = request.headers.get('x-twilio-signature') || ''
  if (!validateTwilioWebhook(signature, publicUrl, params)) {
    logger.warn('Rejected TwiML request with invalid Twilio signature', { publicUrl })
    return NextResponse.json({ error: 'Invalid signature' }, { status: 403 })
  }

  // Browser path passes the token as a POST param; bridge path as a query param.
  const dialToken = params['dialToken'] || url.searchParams.get('dialToken') || ''
  const callSid = params['CallSid']
  if (!dialToken) {
    return declineTwiml('Sorry, this call could not be placed.')
  }

  const supabase = createServiceClient()

  // 2. Exchange the one-time token for the prepared call. Must be unconsumed
  //    (no twilio_call_sid yet), still 'initiated', and recent.
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString()
  const { data: call } = await supabase
    .from('voice_calls')
    .select('id, to_number, from_number, recording_disclosure_given, twilio_call_sid, created_at')
    .eq('dial_token', dialToken)
    .eq('status', 'initiated')
    .is('twilio_call_sid', null)
    .gte('created_at', twoMinutesAgo)
    .maybeSingle()

  if (!call) {
    logger.warn('TwiML dial token not found / already used / expired', { callSid })
    return declineTwiml('Sorry, this call has expired.')
  }

  // Consume the token: bind the AGENT (browser) leg to the row so it can't be
  // replayed. The lead leg SID is stored below once we originate it.
  await supabase
    .from('voice_calls')
    .update({ twilio_call_sid: callSid, status: 'ringing', started_at: new Date().toISOString() })
    .eq('id', call.id)

  // Bridge via a conference so the lead can later be put on hold with music (a peer
  // <Dial> can't hold). Originate the lead's leg into the room; its call
  // statusCallback (tagged with ?voiceCallId=) drives ringing → answered →
  // completed, and the recording callback carries the same tag for matching.
  const statusCallbackUrl = `${origin}/api/voice/status?voiceCallId=${call.id}`
  try {
    const leadCallSid = await dialLeadIntoConference({
      callId: call.id,
      toNumber: call.to_number,
      callerId: call.from_number,
      statusCallbackUrl,
    })
    await supabase.from('voice_calls').update({ twilio_lead_call_sid: leadCallSid }).eq('id', call.id)
  } catch (err) {
    logger.error('Failed to originate lead leg for conference bridge', {
      call_id: call.id,
      error: err instanceof Error ? err.message : String(err),
    })
    await supabase.from('voice_calls').update({ status: 'failed', ended_at: new Date().toISOString() }).eq('id', call.id)
    return declineTwiml('Sorry, we could not connect that call.')
  }

  const twiml = buildAgentConferenceTwiml({
    callId: call.id,
    recordingStatusCallbackUrl: statusCallbackUrl,
    record: !!call.recording_disclosure_given,
  })

  logger.info('Browser call bridged via conference', { call_id: call.id, twilio_call_sid: callSid })
  return new NextResponse(twiml, { status: 200, headers: { 'Content-Type': 'text/xml' } })
}
