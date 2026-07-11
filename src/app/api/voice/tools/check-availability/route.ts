/**
 * Retell custom-function endpoint — check_availability
 *
 * The hosted voice agent calls this BEFORE offering any appointment times, so
 * every slot it speaks is a real opening from the booking engine (weekly
 * schedule + existing appointments + CareStack chair occupancy) instead of an
 * invented one. Thin adapter over the same executeAgentTool('check_availability')
 * the SMS/email agents use.
 *
 * Retell → POST { call: { metadata: { lead_id, organization_id, conversation_id } },
 *                 args: { preferred_day? } }
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
      'check_availability',
      { preferred_day: args.preferred_day },
      {
        organization_id: organizationId,
        lead_id: leadId,
        lead,
        conversation_id: conversationId,
        channel: 'voice',
      }
    )
    return toolReply(result.success, result.message, { data: result.data })
  } catch (err) {
    logger.error(
      'voice tool check_availability failed',
      { leadId },
      err instanceof Error ? err : new Error(String(err))
    )
    return toolReply(
      false,
      'Could not load the schedule right now. Do not quote any times — tell the patient the scheduling team will call them back today to lock in a time.'
    )
  }
}
