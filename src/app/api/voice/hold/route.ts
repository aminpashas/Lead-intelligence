/**
 * Hold / resume the lead on a browser-placed conference call.
 *
 * POST /api/voice/hold  { call_id, hold: boolean }  → { ok, held }
 *
 * The browser softphone bridges the agent and lead through a Twilio Conference
 * (see /api/voice/twiml/outbound). Holding updates the LEAD's conference
 * participant with hold=true, which isolates them from the room and plays Twilio's
 * hold music to them — so the lead hears music, not dead air, while the agent steps
 * away. Both directions go quiet automatically; resume (hold=false) rejoins them.
 *
 * Authenticated + org-scoped: a staffer may only hold a call their effective org
 * owns. We never trust a raw conference/participant id from the client — the lead
 * leg SID comes from the voice_calls row the call_id resolves to.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { isSoftphoneConfigured, setLeadHold } from '@/lib/voice/twilio-voice'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  if (!isSoftphoneConfigured()) {
    return NextResponse.json({ error: 'Softphone not configured' }, { status: 503 })
  }

  const authClient = await createClient()
  const {
    data: { user },
  } = await authClient.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { orgId } = await resolveActiveOrg(authClient)
  if (!orgId) {
    return NextResponse.json({ error: 'No organization found' }, { status: 403 })
  }

  const parsed = z
    .object({ call_id: z.string().uuid(), hold: z.boolean() })
    .safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
  const { call_id, hold } = parsed.data

  // Resolve the lead leg SID from the row, scoped to the caller's org.
  const supabase = createServiceClient()
  const { data: call } = await supabase
    .from('voice_calls')
    .select('id, organization_id, twilio_lead_call_sid, status')
    .eq('id', call_id)
    .eq('organization_id', orgId)
    .maybeSingle()

  if (!call) {
    return NextResponse.json({ error: 'Call not found' }, { status: 404 })
  }
  if (!call.twilio_lead_call_sid) {
    return NextResponse.json({ error: 'Call is not on a conference bridge' }, { status: 409 })
  }

  const applied = await setLeadHold({
    callId: call.id,
    leadCallSid: call.twilio_lead_call_sid,
    hold,
  })
  if (!applied) {
    // No live conference/participant — lead likely already dropped.
    return NextResponse.json({ error: 'Call is no longer active' }, { status: 409 })
  }

  logger.info('Browser call hold toggled', { call_id: call.id, hold, user_id: user.id })
  return NextResponse.json({ ok: true, held: hold })
}
