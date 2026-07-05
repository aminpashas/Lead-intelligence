/**
 * Retell custom-function endpoint — verify_identity
 *
 * The live (Retell-hosted-LLM) voice agent calls this mid-call when it needs to
 * confirm the caller is the patient before disclosing case-specific PHI. It is
 * the phone-side mirror of the `verify_identity` tool used by the repo's own
 * SMS/voice agents (src/lib/autopilot/agent-tools.ts) and shares the same
 * verifyDob() logic and the same `conversations.identity_verified_at` flag.
 *
 * Retell → POST { call: { metadata: { lead_id, conversation_id, organization_id } },
 *                 args: { date_of_birth } }
 * Response → { verified: boolean, message: string }  (the LLM reads `message`).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { verifyRetellWebhook } from '@/lib/voice/retell-client'
import { verifyDob } from '@/lib/ai/identity-verification'
import { logger } from '@/lib/logger'

const DENY_MESSAGE =
  'The date of birth did not match our records. Do not share any appointment, treatment, financing, or insurance details. Ask them to confirm their date of birth once more; if it still does not match, offer a callback from a team member.'

export async function POST(request: NextRequest) {
  const rawBody = await request.text()

  // Same signature gate as the main Retell webhook — fails closed in production.
  const signature = request.headers.get('x-retell-signature') || ''
  if (!(await verifyRetellWebhook(rawBody, signature))) {
    return new NextResponse('Invalid signature', { status: 401 })
  }

  let body: {
    call?: { metadata?: Record<string, unknown> }
    args?: Record<string, unknown>
    arguments?: Record<string, unknown>
  }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const metadata = body.call?.metadata || {}
  const leadId = metadata.lead_id as string | undefined
  const conversationId = metadata.conversation_id as string | undefined
  const organizationId = metadata.organization_id as string | undefined

  // Retell nests function args under `args` (or `arguments` on some versions).
  const fnArgs = body.args || body.arguments || {}
  const claimedDob = String(fnArgs.date_of_birth ?? '').trim()

  if (!leadId || !conversationId || !organizationId || !claimedDob) {
    // Missing context/arg → treat as not verified (fail closed), don't 500.
    return NextResponse.json({ verified: false, message: DENY_MESSAGE })
  }

  const supabase = createServiceClient()

  const { data: lead } = await supabase
    .from('leads')
    .select('date_of_birth')
    .eq('id', leadId)
    .eq('organization_id', organizationId)
    .single()

  const matched = verifyDob(claimedDob, lead?.date_of_birth as string | null | undefined)
  if (!matched) {
    return NextResponse.json({ verified: false, message: DENY_MESSAGE })
  }

  const { error } = await supabase
    .from('conversations')
    .update({ identity_verified_at: new Date().toISOString(), identity_verified_via: 'dob' })
    .eq('id', conversationId)
    .eq('organization_id', organizationId)

  if (error) {
    logger.error('verify-identity: failed to persist verified flag', { conversationId }, error)
    // The DOB matched, but we could not persist. Fail closed so a later turn
    // re-verifies rather than silently disclosing on an unrecorded verification.
    return NextResponse.json({ verified: false, message: DENY_MESSAGE })
  }

  return NextResponse.json({
    verified: true,
    message:
      'Identity verified via date of birth. You may now discuss this patient\'s appointment, treatment, and financing details for the rest of this call.',
  })
}
