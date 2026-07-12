/**
 * Authenticated streaming proxy for call recordings.
 *
 * GET /api/voice/recording/[id] — streams the recording for a voice_calls row.
 *
 * Why it exists: Twilio recording media (browser-softphone conference
 * recordings) requires the account SID + auth token to fetch, and an <audio>
 * tag cannot attach Basic auth — so staff-call recordings were unplayable in
 * the UI. This route checks the caller's session + org, fetches from Twilio
 * with server credentials, and streams the audio back (forwarding Range
 * headers so the player can scrub). Retell URLs are public, so those just
 * 302-redirect to the source.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { isTwilioRecordingUrl } from '@/lib/voice/recording-playback'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const authClient = await createClient()
  const {
    data: { user },
  } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { orgId, role } = await resolveActiveOrg(authClient)
  if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 403 })

  const supabase = createServiceClient()
  const { data: call } = await supabase
    .from('voice_calls')
    .select('id, organization_id, recording_url')
    .eq('id', id)
    .maybeSingle()

  // Org isolation: the caller must be in the call's org (or an agency admin,
  // who reaches client practices via the acting-as context).
  if (!call || (call.organization_id !== orgId && role !== 'agency_admin')) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (!call.recording_url) {
    return NextResponse.json({ error: 'No recording for this call' }, { status: 404 })
  }

  // Retell (and any other public) recordings: no credentials needed.
  if (!isTwilioRecordingUrl(call.recording_url)) {
    return NextResponse.redirect(call.recording_url)
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!accountSid || !authToken) {
    return NextResponse.json({ error: 'Twilio not configured' }, { status: 503 })
  }

  // The RecordingUrl callback param has no extension; ask Twilio for mp3.
  const mediaUrl = /\.(mp3|wav)$/i.test(call.recording_url)
    ? call.recording_url
    : `${call.recording_url}.mp3`

  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
  }
  // Forward Range so the <audio> scrubber can seek without full downloads.
  const range = request.headers.get('range')
  if (range) headers['Range'] = range

  const upstream = await fetch(mediaUrl, { headers })
  if (!upstream.ok && upstream.status !== 206) {
    logger.warn('Recording proxy upstream fetch failed', { call_id: id, status: upstream.status })
    return NextResponse.json({ error: 'Recording unavailable' }, { status: 502 })
  }

  const passthrough = new Headers()
  passthrough.set('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg')
  for (const h of ['content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h)
    if (v) passthrough.set(h, v)
  }
  // Recordings are immutable; let the browser cache privately for a day.
  passthrough.set('Cache-Control', 'private, max-age=86400')

  return new NextResponse(upstream.body, { status: upstream.status, headers: passthrough })
}
