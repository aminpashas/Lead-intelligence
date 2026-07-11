/**
 * Retell custom-function endpoint — verify_identity
 *
 * The live (Retell-hosted-LLM) voice agent calls this mid-call when it needs to
 * confirm the caller is the patient before disclosing case-specific PHI. It is
 * the phone-side mirror of the `verify_identity` tool used by the repo's own
 * SMS/voice agents (src/lib/autopilot/agent-tools.ts) and shares the same
 * verifyDob() logic and the same `conversations.identity_verified_at` flag.
 *
 * Auth: uses the shared parseRetellToolRequest (secret OR signature) — the same
 * gate as check-availability / book-appointment / update-contact. It previously
 * used signature-only verification, which fails on this account (Retell signs
 * with a key that isn't our RETELL_API_KEY) and made the tool 401 on every call.
 *
 * Retell → POST { call: { metadata: { lead_id, conversation_id, organization_id } },
 *                 args: { date_of_birth } }
 * Response → { success, verified, message }  (the LLM reads `message`).
 */

import { NextRequest } from 'next/server'
import { parseRetellToolRequest, toolReply } from '@/lib/voice/tool-endpoint'
import { verifyDob } from '@/lib/ai/identity-verification'
import { logger } from '@/lib/logger'

const DENY_MESSAGE =
  'The date of birth did not match our records. Do not share any appointment, treatment, financing, or insurance details. Ask them to confirm their date of birth once more; if it still does not match, offer a callback from a team member.'

export async function POST(request: NextRequest) {
  const parsed = await parseRetellToolRequest(request)
  if (!parsed.ok) return parsed.response
  const { supabase, leadId, organizationId, conversationId, lead, args } = parsed.req

  const claimedDob = String(args.date_of_birth ?? '').trim()
  if (!claimedDob || !conversationId) {
    // Missing arg/context → treat as not verified (fail closed), don't 500.
    return toolReply(false, DENY_MESSAGE, { verified: false })
  }

  const matched = verifyDob(claimedDob, lead.date_of_birth as string | null | undefined)
  if (!matched) {
    return toolReply(false, DENY_MESSAGE, { verified: false })
  }

  const { error } = await supabase
    .from('conversations')
    .update({ identity_verified_at: new Date().toISOString(), identity_verified_via: 'dob' })
    .eq('id', conversationId)
    .eq('organization_id', organizationId)

  if (error) {
    logger.error('verify-identity: failed to persist verified flag', { conversationId }, new Error(error.message))
    // The DOB matched, but we could not persist. Fail closed so a later turn
    // re-verifies rather than silently disclosing on an unrecorded verification.
    return toolReply(false, DENY_MESSAGE, { verified: false })
  }

  return toolReply(
    true,
    "Identity verified via date of birth. You may now discuss this patient's appointment, treatment, and financing details for the rest of this call.",
    { verified: true }
  )
}
