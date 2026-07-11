/**
 * Retell custom-function endpoint — book_appointment
 *
 * Creates a REAL appointment via the same executeAgentTool('create_booking')
 * path the text agents use: re-validates the slot against live availability,
 * writes the tz-correct appointments row, syncs to the EHR, updates lead
 * status, logs HIPAA audit, and fires the confirmation SMS/email. The agent
 * may only tell the patient they're booked when this returns success.
 *
 * channel:'voice' matters — the phone-first gate blocks text-channel bookings
 * until a qualifying call has happened, but a live voice call IS that call.
 *
 * Retell → POST { call: { metadata: { lead_id, organization_id, conversation_id } },
 *                 args: { date: 'YYYY-MM-DD', time: 'HH:MM' } }
 * Response → { success, message }  (the LLM reads `message`).
 */

import { NextRequest } from 'next/server'
import { executeAgentTool } from '@/lib/autopilot/agent-tools'
import { parseRetellToolRequest, toolReply } from '@/lib/voice/tool-endpoint'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  const parsed = await parseRetellToolRequest(request)
  if (!parsed.ok) return parsed.response
  const { supabase, leadId, organizationId, conversationId, lead, args } = parsed.req

  try {
    const result = await executeAgentTool(
      supabase,
      'create_booking',
      { date: args.date, time: args.time },
      {
        organization_id: organizationId,
        lead_id: leadId,
        lead,
        conversation_id: conversationId,
        channel: 'voice',
        agent_role: 'setter',
      }
    )
    return toolReply(result.success, result.message, { data: result.data })
  } catch (err) {
    logger.error(
      'voice tool book_appointment failed',
      { leadId },
      err instanceof Error ? err : new Error(String(err))
    )
    return toolReply(
      false,
      'The booking could not be completed. Do NOT tell the patient they are booked. Apologize and say the scheduling team will call them back today to confirm a time.'
    )
  }
}
