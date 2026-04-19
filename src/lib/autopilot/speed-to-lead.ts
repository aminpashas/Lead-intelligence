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
import { getAutopilotConfig } from './config'
import { routeToAgent } from '@/lib/ai/agent-handoff'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { sendEmailToLead } from '@/lib/messaging/resend'
import { decryptField } from '@/lib/encryption'
import type { AgentContext, ConversationMessage } from '@/lib/ai/agent-types'
import type { ConversationChannel, LeadStatus } from '@/types/database'
import { logger } from '@/lib/logger'
import { createEscalation } from './escalation'

export type SpeedToLeadResult = {
  action: 'sent' | 'skipped' | 'escalated' | 'no_contact'
  channel?: 'sms' | 'email'
  message?: string
  conversation_id?: string
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

  // HIGH-3: Check active hours (TCPA quiet hours compliance)
  const currentHour = new Date().getHours()
  if (currentHour < config.active_hours_start || currentHour >= config.active_hours_end) {
    logger.info('Speed-to-lead: skipped outside active hours', {
      leadId,
      currentHour,
      activeRange: `${config.active_hours_start}-${config.active_hours_end}`,
    })
    return { action: 'skipped' }
  }

  // 2. Fetch the lead
  const { data: lead } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single()

  if (!lead) return { action: 'skipped' }

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
      })
      if (!result.sent) {
        logger.warn('Speed-to-lead email blocked', { leadId, reason: result.reason })
        return { action: 'skipped' }
      }
    }

    // Store outbound message
    await supabase.from('messages').insert({
      organization_id: organizationId,
      conversation_id: conversationId,
      lead_id: leadId,
      direction: 'outbound',
      channel,
      body: agentResponse.message,
      sender_type: 'ai',
      status: 'sent',
      external_id: externalId || null,
      ai_generated: true,
      ai_confidence: agentResponse.confidence,
      ai_model: 'claude-sonnet-4-20250514',
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
