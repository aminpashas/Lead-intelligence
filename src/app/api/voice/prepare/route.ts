/**
 * Prepare a browser-placed outbound call.
 *
 * POST /api/voice/prepare  { lead_id }  → { dial_token, call_id, to_last4 }
 * POST /api/voice/prepare  { to }       → { dial_token, call_id, to_last4 }  (dial-any-number)
 *
 * This is the AUTHENTICATED half of the softphone dial. For a lead it runs the same
 * compliance gate as the AI dialer (consent, DNC, TCPA window, rate limit); for a
 * typed number it runs the reduced manual gate (E.164, DNC-by-number, org enabled,
 * rate limit). Either way it creates the voice_calls row in the caller's real
 * session and mints a one-time `dial_token`. The browser then hands only that token
 * to Twilio; the public TwiML route (/api/voice/twiml/outbound) exchanges it for the
 * <Dial>.
 *
 * Why a token instead of passing lead_id/to/org_id as Twilio dial params: those
 * params are attacker-controllable form fields on the public TwiML endpoint, so a
 * staffer could dial another org's lead or an arbitrary number on our caller ID.
 * Minting the intent here — where we know the real session and effective org —
 * closes that hole and lets us surface a clear reason to the user BEFORE the call
 * starts.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { assertActiveSubscription } from '@/lib/auth/entitlement'
import { prepareStaffCallIntent, prepareManualCallIntent } from '@/lib/voice/call-manager'
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

  // Dial either a known lead (lead_id) or an arbitrary typed number (to). Exactly
  // one is required; the two run different server-side gates.
  const parsed = z
    .union([
      z.object({ lead_id: z.string().uuid() }),
      z.object({ to: z.string().min(1).max(32) }),
    ])
    .safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const intent =
    'lead_id' in parsed.data
      ? await prepareStaffCallIntent(supabase, {
          organizationId: orgId,
          leadId: parsed.data.lead_id,
          staffUserId: user.id,
          callMode: 'browser',
        })
      : await prepareManualCallIntent(supabase, {
          organizationId: orgId,
          staffUserId: user.id,
          toNumber: parsed.data.to,
        })
  if ('error' in intent) {
    return NextResponse.json({ error: intent.error }, { status: intent.status })
  }

  logger.info('Browser call prepared', {
    user_id: user.id,
    mode: 'lead_id' in parsed.data ? 'lead' : 'manual',
    call_id: intent.callId,
  })

  return NextResponse.json({
    dial_token: intent.dialToken,
    call_id: intent.callId,
    to_last4: intent.phone.replace(/[^0-9]/g, '').slice(-4),
    // Whether this call is already threaded onto a lead. When false (a manual dial
    // to an unknown number), the softphone offers a capture-the-contact form so the
    // staffer can turn the call into a real lead as they talk.
    matched_lead: !!intent.matchedLeadId,
  })
}
