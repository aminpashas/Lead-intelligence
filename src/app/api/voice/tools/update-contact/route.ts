/**
 * Retell custom-function endpoint — update_contact
 *
 * Persists contact details the patient gives DURING the call (today: email) to
 * the lead record, encrypted at rest with the search hash maintained. Without
 * this, an email spoken on a call evaporates when the call ends — the agent
 * re-asks on every call and confirmations have nowhere to go.
 *
 * Retell → POST { call: { metadata: { lead_id, organization_id, conversation_id } },
 *                 args: { email } }
 * Response → { success, message }  (the LLM reads `message`).
 */

import { NextRequest } from 'next/server'
import { parseRetellToolRequest, toolReply } from '@/lib/voice/tool-endpoint'
import { encryptLeadPII } from '@/lib/encryption'
import { recordAudit } from '@/lib/audit/record'
import { logger } from '@/lib/logger'

// Deliberately simple: catches speech-transcription artifacts ("at", spaces)
// without rejecting unusual-but-valid addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export async function POST(request: NextRequest) {
  const parsed = await parseRetellToolRequest(request, { requireLead: false })
  if (!parsed.ok) return parsed.response
  const { supabase, leadId, organizationId, args } = parsed.req

  const email = String(args.email ?? '').trim().toLowerCase()

  if (!EMAIL_RE.test(email)) {
    return toolReply(
      false,
      `"${email}" does not look like a valid email address — it may have been transcribed wrong. Read it back to the patient and ask them to spell it out, then try again.`
    )
  }

  const { error } = await supabase
    .from('leads')
    .update(encryptLeadPII({ email }))
    .eq('id', leadId)
    .eq('organization_id', organizationId)

  if (error) {
    logger.error('voice tool update_contact failed', { leadId }, new Error(error.message))
    return toolReply(
      false,
      'The email could not be saved right now. Tell the patient a team member will confirm their contact details after the call.'
    )
  }

  // Best-effort audit; never blocks the reply to the agent.
  void recordAudit(supabase, {
    organizationId,
    action: 'lead.contact_updated',
    actor: { actorType: 'ai_agent', actorId: null, actorLabel: 'AI Voice Agent' },
    source: 'webhook',
    resourceType: 'lead',
    resourceId: leadId,
    ai: { autonomous: true, agent_role: 'voice' },
    metadata: { field: 'email', via: 'voice_call' },
  })

  return toolReply(
    true,
    `Saved. The patient's email on file is now ${email}. Confirmations will go to this address — no need to ask for it again on future calls.`
  )
}
