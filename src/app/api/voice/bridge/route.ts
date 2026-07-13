/**
 * Ring-my-phone bridge dial.
 *
 * POST /api/voice/bridge  { lead_id }  → { call_id, staff_last4 }
 *
 * For staff without a headset: instead of talking through the browser, Twilio
 * calls the staff member's OWN phone first, and when they answer, bridges them to
 * the lead. No WebRTC audio — purely server-initiated.
 *
 * Reuses the exact same compliance gate + one-time dial token as the browser
 * softphone (prepareStaffCallIntent). The only difference is leg A: here it's the
 * staff phone (via calls.create) rather than a browser Device. Twilio fetches the
 * SAME /api/voice/twiml/outbound, keyed by the token on the query string.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import twilio from 'twilio'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { assertActiveSubscription } from '@/lib/auth/entitlement'
import { prepareStaffCallIntent } from '@/lib/voice/call-manager'
import { isSoftphoneConfigured } from '@/lib/voice/twilio-voice'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  if (!isSoftphoneConfigured()) {
    return NextResponse.json({ error: 'Softphone not configured' }, { status: 503 })
  }

  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { orgId } = await resolveActiveOrg(authClient)
  if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 403 })

  const entError = await assertActiveSubscription(authClient, orgId)
  if (entError) return entError

  const parsed = z.object({ lead_id: z.string().uuid() }).safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const { lead_id } = parsed.data

  // The number Twilio rings first — the staff member's own phone from their profile.
  const { data: profile } = await getOwnProfile(authClient, 'phone')
  const staffPhone = (profile?.phone as string | null)?.replace(/[\s\-()]/g, '') || null
  if (!staffPhone || !/^\+?1?\d{10,15}$/.test(staffPhone)) {
    return NextResponse.json(
      {
        error: 'Add your mobile number under Settings → Your Profile to use “Call my phone”',
        code: 'no_staff_phone',
      },
      { status: 422 }
    )
  }

  const supabase = createServiceClient()
  const intent = await prepareStaffCallIntent(supabase, {
    organizationId: orgId,
    leadId: lead_id,
    staffUserId: user.id,
    callMode: 'bridge',
  })
  if ('error' in intent) {
    return NextResponse.json({ error: intent.error }, { status: intent.status })
  }

  // Ring the staff phone; on answer, Twilio fetches the TwiML (which consumes the
  // token and dials the lead). Voice URL host must match what /twiml reconstructs.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || ''
  const voiceUrl = `${appUrl}/api/voice/twiml/outbound?dialToken=${intent.dialToken}`

  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!)
    await client.calls.create({
      to: staffPhone,
      from: intent.fromNumber,
      url: voiceUrl,
      method: 'POST',
    })
  } catch (error) {
    await supabase
      .from('voice_calls')
      .update({ status: 'failed', ended_at: new Date().toISOString(), outcome: 'technical_failure' })
      .eq('id', intent.callId)
    logger.error('Bridge call failed', { call_id: intent.callId }, error instanceof Error ? error : undefined)
    return NextResponse.json({ error: 'Could not start the bridge call' }, { status: 500 })
  }

  logger.info('Bridge call started', { user_id: user.id, lead_id, call_id: intent.callId })
  return NextResponse.json({ call_id: intent.callId, staff_last4: staffPhone.slice(-4) })
}
