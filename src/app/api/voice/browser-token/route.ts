/**
 * Browser softphone access token.
 *
 * GET /api/voice/browser-token — issues a short-lived Twilio Voice access token
 * scoped to the signed-in staff member. The browser `Device` uses it to register
 * with Twilio; it grants OUTGOING calls only (see mintVoiceToken).
 *
 * The token authorizes the device to place calls THROUGH our TwiML App — it does
 * not by itself authorize dialing any particular number. Which number gets dialed
 * is decided later, per call, by /api/voice/twiml/outbound against a one-time
 * dial token from /api/voice/prepare (which runs the compliance gate).
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { assertActiveSubscription } from '@/lib/auth/entitlement'
import { mintVoiceToken, isSoftphoneConfigured } from '@/lib/voice/twilio-voice'
import { logger } from '@/lib/logger'

export async function GET() {
  if (!isSoftphoneConfigured()) {
    return NextResponse.json({ error: 'Softphone not configured' }, { status: 503 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) {
    return NextResponse.json({ error: 'No organization found' }, { status: 403 })
  }

  const entError = await assertActiveSubscription(supabase, orgId)
  if (entError) return entError

  try {
    const { token, identity, expiresInSeconds } = mintVoiceToken(user.id)
    return NextResponse.json({ token, identity, expiresInSeconds })
  } catch (error) {
    logger.error('Failed to mint voice token', { user_id: user.id }, error instanceof Error ? error : undefined)
    return NextResponse.json({ error: 'Failed to mint token' }, { status: 500 })
  }
}
