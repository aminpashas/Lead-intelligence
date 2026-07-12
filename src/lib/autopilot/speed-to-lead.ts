/**
 * Speed-to-Lead: Proactive AI First Outreach
 *
 * When a new lead arrives (form, ad, booking, etc.), this module
 * immediately invokes the Setter Agent to compose a personalized
 * first message and sends it — no templates, no human in the loop.
 *
 * Speed-to-lead is the #1 predictor of lead conversion.
 * Response within 5 minutes = 21x more likely to qualify.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getAutopilotConfig, getLocalHourAndDay } from './config'
import { routeToAgent } from '@/lib/ai/agent-handoff'
import { canDisclosePHI } from '@/lib/ai/identity-verification'
import { getAgentIdForRole } from '@/lib/agents/agent-resolver'
import { checkAgentCapacity } from '@/lib/agents/discipline-engine'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { sendEmailToLead } from '@/lib/messaging/resend'
import { decryptField } from '@/lib/encryption'
import { findExistingPatientByHash, markLeadAsExistingPatient } from '@/lib/ehr/patient-lookup'
import type { AgentContext, ConversationMessage } from '@/lib/ai/agent-types'
import type { ConversationChannel, LeadStatus } from '@/types/database'
import { logger } from '@/lib/logger'
import { createEscalation } from './escalation'
import { resolveAutomationOwner } from '@/lib/automation/allocation'
import {
  createHumanTask,
  resolveAssignee,
  taskDedupeKeyForFirstTouch,
} from '@/lib/automation/tasks'

export type SpeedToLeadResult = {
  action: 'sent' | 'skipped' | 'escalated' | 'no_contact'
  channel?: 'sms' | 'email'
  message?: string
  conversation_id?: string
  reason?: string
}

/**
 * Trigger proactive first outreach to a new lead.
 * Called immediately after lead creation (form webhook, ad webhook, etc.)
 */
export async function triggerSpeedToLead(
  supabase: SupabaseClient,
  leadId: string,
  organizationId: string
): Promise<SpeedToLeadResult> {
  // 1. Check if autopilot + speed-to-lead is enabled
  const config = await getAutopilotConfig(supabase, organizationId)
  if (!config.enabled || config.paused || !config.speed_to_lead) {
    return { action: 'skipped' }
  }

  // Shadow mode (cutover safety): score/draft are still useful upstream, but
  // never send outbound while LI runs beside GoHighLevel. Bail before any send.
  if (config.outreach_suppressed) {
    logger.info('Speed-to-lead: skipped, outreach_suppressed', { leadId, reason: 'outreach_suppressed' })
    return { action: 'skipped' }
  }

  // Allocation policy gate (Workstream D1, dormant by default): if a policy
  // allocates first touch to a human (or human-first hold), the AI stands down.
  // With zero policy rows this always resolves to 'ai' (legacy path).
  const allocation = await resolveAutomationOwner(supabase, {
    organizationId,
    kind: 'speed_to_lead',
  })
  if (allocation.owner !== 'ai') {
    // D2: a human owns the first touch — queue it as a task so the lead isn't
    // silently dropped. 'hold' carries the SLA in due_at (D3 enforces the AI
    // takeover). Task creation fails soft; the AI stands down either way.
    logger.info('Speed-to-lead: skipped, allocated to human', {
      leadId,
      owner: allocation.owner,
      reason: allocation.reason,
      policyId: allocation.policyId,
    })

    const { data: taskLead } = await supabase
      .from('leads')
      .select('first_name')
      .eq('id', leadId)
      .maybeSingle()
    const rawFirstName = (taskLead?.first_name as string) || ''
    const firstName = decryptField(rawFirstName) || rawFirstName || 'new lead'
    const assignee = await resolveAssignee(supabase, organizationId, leadId)
    const dueAt =
      allocation.owner === 'hold' && allocation.slaSeconds
        ? new Date(Date.now() + allocation.slaSeconds * 1000).toISOString()
        : null

    await createHumanTask(supabase, {
      organization_id: organizationId,
      kind: 'first_touch',
      title: `First touch: ${firstName}`,
      detail: 'New lead allocated to a human for first outreach (speed-to-lead stood down).',
      source: 'allocation',
      lead_id: leadId,
      policy_id: allocation.policyId,
      assigned_to: assignee.userId,
      assigned_role: assignee.role,
      due_at: dueAt,
      dedupe_key: taskDedupeKeyForFirstTouch(leadId),
      metadata: {
        allocation_owner: allocation.owner,
        allocation_reason: allocation.reason,
        sla_seconds: allocation.slaSeconds,
      },
    })

    // No conversation exists yet at first touch, so notifyInboundMessage
    // (conversation-keyed) can't run here; the /tasks inbox badge surfaces the
    // first_touch task. Wire a lead-keyed staff ping here if that proves slow.

    return { action: 'skipped', reason: 'allocated_to_human' }
  }

  // HIGH-3: Check active hours (TCPA quiet hours compliance).
  // Hour must be evaluated in the org's local timezone, not UTC (Vercel runs UTC).
  const { hour: currentHour } = getLocalHourAndDay(config.timezone)
  if (currentHour < config.active_hours_start || currentHour >= config.active_hours_end) {
    logger.info('Speed-to-lead: skipped outside active hours', {
      leadId,
      currentHour,
      activeRange: `${config.active_hours_start}-${config.active_hours_end}`,
    })
    return { action: 'skipped' }
  }

  // PHASE C: Reward/discipline gate.
  // First-touch goes through the Setter agent. Check that agent's
  // remaining daily capacity AND its autopilot override before doing
  // any work. Probated agents have autopilot='review_first', so this
  // path skips them and the lead falls through to the manual queue
  // (where speed-to-lead's existing escalation logic can pick it up).
  const setterAgentId = await getAgentIdForRole(supabase, organizationId, 'setter')
  if (setterAgentId) {
    const capacity = await checkAgentCapacity(supabase, setterAgentId)
    if (!capacity.allowed) {
      logger.info('Speed-to-lead: blocked by agent capacity / autopilot', {
        leadId,
        agentId: setterAgentId,
        reason: capacity.reason,
        effectiveCap: capacity.effectiveCap,
      })
      // Cap-reached or autopilot-throttled leads aren't lost — they
      // remain in the queue and get picked up by the next pass once
      // capacity returns or the agent's status improves.
      return { action: 'skipped' }
    }
  }

  // 2. Fetch the lead
  const { data: lead } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single()

  if (!lead) return { action: 'skipped' }

  // Existing-patient gate: a contact who already exists as a synced EHR patient
  // belongs to the front-desk / Dion Desk flow, not the sales setter — never
  // auto-outreach them. The flag is normally set at ingestion; fall back to a
  // live hash match for leads created via other paths (and backfill the flag).
  let isExistingPatient = lead.is_existing_patient === true
  if (!isExistingPatient && (lead.email_hash || lead.phone_hash)) {
    const match = await findExistingPatientByHash(supabase, organizationId, {
      emailHash: lead.email_hash,
      phoneHash: lead.phone_hash,
    })
    if (match) {
      isExistingPatient = true
      try {
        await markLeadAsExistingPatient(supabase, leadId, organizationId, match.patientId)
      } catch {
        // Non-fatal: the gate below still suppresses outreach.
      }
    }
  }
  if (isExistingPatient) {
    logger.info('Speed-to-lead: skipped, existing patient', { leadId, reason: 'existing_patient' })
    return { action: 'skipped' }
  }

  // 3. Determine channel (prefer SMS if phone exists and consent given)
  const hasPhone = lead.phone_formatted && lead.sms_consent && !lead.sms_opt_out
  const hasEmail = lead.email && lead.email_consent && !lead.email_opt_out
  const phone = hasPhone ? (decryptField(lead.phone_formatted) || lead.phone_formatted) : null
  const email = hasEmail ? (decryptField(lead.email) || lead.email) : null

  if (!phone && !email) {
    return { action: 'no_contact' }
  }

  const channel: 'sms' | 'email' = phone ? 'sms' : 'email'

  // 4. Create or find conversation
  let conversationId: string

  const { data: existingConvo } = await supabase
    .from('conversations')
    .select('id')
    .eq('lead_id', leadId)
    .eq('channel', channel)
    .eq('status', 'active')
    .limit(1)
    .single()

  if (existingConvo) {
    conversationId = existingConvo.id
  } else {
    const { data: newConvo, error } = await supabase
      .from('conversations')
      .insert({
        organization_id: organizationId,
        lead_id: leadId,
        channel,
        status: 'active',
        ai_enabled: true,
        ai_mode: 'auto',
        active_agent: 'setter',
      })
      .select('id')
      .single()

    if (error || !newConvo) {
      logger.error('Speed-to-lead: failed to create conversation', { leadId, error: error?.message })
      return { action: 'skipped' }
    }
    conversationId = newConvo.id
  }

  // 5. Build agent context (empty history for first message)
  const agentContext: AgentContext = {
    lead,
    conversation_id: conversationId,
    organization_id: organizationId,
    channel: channel as ConversationChannel,
    lead_status: (lead.status || 'new') as LeadStatus,
    patient_profile: null, // No profile yet for new leads
    conversation_history: [] as ConversationMessage[],
    handoff_history: [],
    message_count: 0,
    // First outbound touch to a fresh lead — no case data yet, so this resolves
    // to true; wired for consistency so the gate is uniform across surfaces.
    disclose_phi: canDisclosePHI({ lead, verifiedAt: null, channel }),
  }

  // 6. Get AI response from Setter Agent
  let agentResponse
  try {
    agentResponse = await routeToAgent(supabase, agentContext)
  } catch (error) {
    logger.error('Speed-to-lead: agent failed', { leadId }, error instanceof Error ? error : undefined)

    await createEscalation(supabase, {
      organization_id: organizationId,
      conversation_id: conversationId,
      lead_id: leadId,
      reason: 'agent_failure',
      ai_notes: `Speed-to-lead agent failed: ${error instanceof Error ? error.message : 'Unknown'}`,
    })

    return { action: 'escalated' }
  }

  // 7. Confidence check
  if (agentResponse.confidence < config.confidence_threshold) {
    await createEscalation(supabase, {
      organization_id: organizationId,
      conversation_id: conversationId,
      lead_id: leadId,
      reason: 'low_confidence',
      ai_notes: `Speed-to-lead confidence too low: ${agentResponse.confidence}`,
      ai_draft_response: agentResponse.message,
      ai_confidence: agentResponse.confidence,
      agent_type: agentResponse.agent,
    })

    return { action: 'escalated', message: agentResponse.message }
  }

  // 8. Send the message (consent gate enforced inside sendSMSToLead / sendEmailToLead)
  try {
    let externalId: string | undefined

    if (channel === 'sms' && phone) {
      const result = await sendSMSToLead({
        supabase,
        leadId,
        to: phone,
        body: agentResponse.message,
        caller: 'autopilot.speed_to_lead',
        aiGenerated: true,
        blockOnReview: true,
      })
      if (!result.sent) {
        logger.warn('Speed-to-lead SMS blocked', { leadId, reason: result.reason })
        return { action: 'skipped' }
      }
      externalId = result.sid
    } else if (channel === 'email' && email) {
      const result = await sendEmailToLead({
        supabase,
        leadId,
        to: email,
        subject: 'Thanks for reaching out!',
        html: `<div style="font-family: -apple-system, sans-serif; padding: 24px;">${agentResponse.message.replace(/\n/g, '<br>')}</div>`,
        text: agentResponse.message,
        caller: 'autopilot.speed_to_lead',
        aiGenerated: true,
        blockOnReview: true,
      })
      if (!result.sent) {
        logger.warn('Speed-to-lead email blocked', { leadId, reason: result.reason })
        return { action: 'skipped' }
      }
    }

    // Store outbound message
    const agentId = await getAgentIdForRole(supabase, organizationId, agentResponse.agent)
    await supabase.from('messages').insert({
      organization_id: organizationId,
      conversation_id: conversationId,
      lead_id: leadId,
      agent_id: agentId,
      direction: 'outbound',
      channel,
      body: agentResponse.message,
      sender_type: 'ai',
      status: 'sent',
      external_id: externalId || null,
      ai_generated: true,
      ai_confidence: agentResponse.confidence,
      ai_model: 'claude-sonnet-4-6',
      metadata: {
        agent: agentResponse.agent,
        action_taken: agentResponse.action_taken,
        autopilot: true,
        speed_to_lead: true,
      },
    })

    // Update lead status to 'contacted'
    if (lead.status === 'new') {
      await supabase
        .from('leads')
        .update({ status: 'contacted', last_contacted_at: new Date().toISOString() })
        .eq('id', leadId)
    }

    // Log activity
    await supabase.from('lead_activities').insert({
      organization_id: organizationId,
      lead_id: leadId,
      activity_type: 'ai_speed_to_lead',
      title: `AI speed-to-lead: first ${channel} sent automatically`,
      description: agentResponse.message.substring(0, 200),
      metadata: {
        channel,
        confidence: agentResponse.confidence,
        agent: agentResponse.agent,
      },
    })

    logger.info('Speed-to-lead sent', {
      leadId,
      channel,
      confidence: agentResponse.confidence,
    })

    return {
      action: 'sent',
      channel,
      message: agentResponse.message,
      conversation_id: conversationId,
    }
  } catch (error) {
    logger.error('Speed-to-lead: delivery failed', { leadId, channel }, error instanceof Error ? error : undefined)

    await createEscalation(supabase, {
      organization_id: organizationId,
      conversation_id: conversationId,
      lead_id: leadId,
      reason: 'agent_failure',
      ai_notes: `Speed-to-lead delivery failed: ${error instanceof Error ? error.message : 'Unknown'}`,
      ai_draft_response: agentResponse.message,
      ai_confidence: agentResponse.confidence,
    })

    return { action: 'escalated' }
  }
}
