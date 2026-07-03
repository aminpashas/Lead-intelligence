/**
 * Prepare a browser-placed outbound call.
 *
 * POST /api/voice/prepare  { lead_id }  → { dial_token, call_id, to_last4 }
 *
 * This is the AUTHENTICATED half of the softphone dial. It runs the same
 * compliance gate as the AI dialer (consent, DNC, TCPA window, rate limit) in the
 * caller's real session, creates the voice_calls row, and mints a one-time
 * `dial_token`. The browser then hands only that token to Twilio; the public
 * TwiML route (/api/voice/twiml/outbound) exchanges it for the <Dial>.
 *
 * Why a token instead of passing lead_id/org_id as Twilio dial params: those
 * params are attacker-controllable form fields on the public TwiML endpoint, so a
 * staffer could dial another org's lead. Minting the intent here — where we know
 * the real session and effective org — closes that hole and lets us surface a
 * clear reason to the user BEFORE the call starts.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
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
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { orgId } = await resolveActiveOrg(authClient)
  if (!orgId) {
    return NextResponse.json({ error: 'No organization found' }, { status: 403 })
  }

  const entError = await assertActiveSubscription(authClient, orgId)
  if (entError) return entError

  const parsed = z.object({ lead_id: z.string().uuid() }).safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
  const { lead_id } = parsed.data

  const supabase = createServiceClient()
  const intent = await prepareStaffCallIntent(supabase, {
    organizationId: orgId,
    leadId: lead_id,
    staffUserId: user.id,
    callMode: 'browser',
  })
  if ('error' in intent) {
    return NextResponse.json({ error: intent.error }, { status: intent.status })
  }

  logger.info('Browser call prepared', { user_id: user.id, lead_id, call_id: intent.callId })

  return NextResponse.json({
    dial_token: intent.dialToken,
    call_id: intent.callId,
    to_last4: intent.phone.replace(/[^0-9]/g, '').slice(-4),
  })
}
