/**
 * Autopilot Auto-Response Engine
 *
 * Core orchestrator for autonomous AI responses. Handles the full flow:
 * 1. Build agent context (lead, conversation history, patient profile)
 * 2. Route to the appropriate agent (Setter or Closer)
 * 3. Evaluate confidence against autopilot threshold
 * 4. Auto-send if approved, or escalate to human if not
 * 5. Store outbound message with full metadata
 *
 * This module is called by:
 * - Twilio webhook (inbound SMS auto-response)
 * - Email-reply webhook (inbound email auto-response)
 * - Speed-to-lead (proactive first outreach)
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { routeToAgent, getHandoffHistory } from '@/lib/ai/agent-handoff'
import { getPatientProfile } from '@/lib/ai/patient-psychology'
import { sendSMS } from '@/lib/messaging/twilio'
import { sendEmail } from '@/lib/messaging/resend'
import { decryptField } from '@/lib/encryption'
import { detectPromptInjection, wrapUserContent } from '@/lib/ai/prompt-guard'
import { logHIPAAEvent } from '@/lib/ai/hipaa'
import {
  getAutopilotConfig,
  shouldAutoRespond,
  detectStopWord,
  checkMessageRateLimit,
  type AutopilotConfig,
} from './config'
import { createEscalation } from './escalation'
import type { AgentContext, AgentResponse, ConversationMessage } from '@/lib/ai/agent-types'
import type { PatientProfile, ConversationChannel, LeadStatus } from '@/types/database'
import { logger } from '@/lib/logger'

export type AutoResponseResult = {
  action: 'sent' | 'escalated' | 'skipped' | 'stopped' | 'rate_limited'
  message?: string
  confidence?: number
  agent?: string
  escalation_id?: string | null
  reason?: string
}

/**
 * Process an inbound message and auto-respond if autopilot is enabled.
 */
export async function processAutoResponse(
  supabase: SupabaseClient,
  params: {
    organization_id: string
    conversation_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation: Record<string, unknown>
    inbound_message: string
    channel: 'sms' | 'email'
    sender_contact: string // phone number or email
  }
): Promise<AutoResponseResult> {
  const { organization_id, conversation_id, lead_id, lead, conversation, inbound_message, channel, sender_contact } = params

  // 1. Load autopilot config
  const config = await getAutopilotConfig(supabase, organization_id)

  if (!config.enabled || config.paused) {
    return { action: 'skipped', reason: 'autopilot_disabled' }
  }

  // 2. Check for stop words (opt-out signals)
  const stopCheck = detectStopWord(inbound_message, config.stop_words)
  if (stopCheck.detected) {
    await handleStopWord(supabase, params, stopCheck.word!, channel)
    return { action: 'stopped', reason: `stop_word: ${stopCheck.word}` }
  }

  // 3. Check rate limit (anti-spam)
  const withinLimit = await checkMessageRateLimit(supabase, conversation_id, config.max_messages_per_hour)
  if (!withinLimit) {
    logger.warn('Autopilot rate limit reached', { conversation_id, max: config.max_messages_per_hour })
    return { action: 'rate_limited', reason: 'max_messages_per_hour_exceeded' }
  }

  // 4. Build conversation history
  const history = await buildConversationHistory(supabase, conversation_id, inbound_message)

  // 5. Build full agent context
  const agentContext = await buildAgentContext(supabase, {
    lead,
    conversation,
    conversation_id,
    organization_id,
    channel,
    history,
  })

  // 6. Route to agent and get response
  let agentResponse: AgentResponse
  try {
    agentResponse = await routeToAgent(supabase, agentContext)
  } catch (error) {
    logger.error('Agent system failed during auto-response', { conversation_id, lead_id }, error instanceof Error ? error : undefined)

    await createEscalation(supabase, {
      organization_id,
      conversation_id,
      lead_id,
      reason: 'agent_failure',
      ai_notes: `Agent system threw error: ${error instanceof Error ? error.message : 'Unknown'}`,
    })

    return { action: 'escalated', reason: 'agent_failure' }
  }

  // 7. Evaluate whether to auto-send
  const currentHour = new Date().getHours()
  const messageCount = (conversation.message_count as number) || 0
  const decision = shouldAutoRespond(config, {
    confidence: agentResponse.confidence,
    agentType: agentResponse.agent,
    isFirstMessage: messageCount === 0,
    currentHour,
  })

  if (!decision.allowed) {
    // Escalate with the AI's draft so a human can review and send
    const escalationId = await createEscalation(supabase, {
      organization_id,
      conversation_id,
      lead_id,
      reason: decision.reason === 'low_confidence' ? 'low_confidence' : 'low_confidence',
      ai_notes: agentResponse.internal_notes || `Auto-response blocked: ${decision.reason}`,
      ai_draft_response: agentResponse.message,
      ai_confidence: agentResponse.confidence,
      agent_type: agentResponse.agent,
    })

    return {
      action: 'escalated',
      message: agentResponse.message,
      confidence: agentResponse.confidence,
      agent: agentResponse.agent,
      escalation_id: escalationId,
      reason: decision.reason,
    }
  }

  // 8. Send the response
  try {
    await sendAgentResponse(supabase, {
      organization_id,
      conversation_id,
      lead_id,
      lead,
      channel,
      sender_contact,
      agentResponse,
    })
  } catch (error) {
    logger.error('Failed to send auto-response', { conversation_id, channel }, error instanceof Error ? error : undefined)

    await createEscalation(supabase, {
      organization_id,
      conversation_id,
      lead_id,
      reason: 'agent_failure',
      ai_notes: `Message delivery failed: ${error instanceof Error ? error.message : 'Unknown'}`,
      ai_draft_response: agentResponse.message,
      ai_confidence: agentResponse.confidence,
    })

    return { action: 'escalated', reason: 'delivery_failure' }
  }

  return {
    action: 'sent',
    message: agentResponse.message,
    confidence: agentResponse.confidence,
    agent: agentResponse.agent,
  }
}

/**
 * Build conversation history from stored messages + new inbound message.
 */
async function buildConversationHistory(
  supabase: SupabaseClient,
  conversationId: string,
  newMessage: string
): Promise<ConversationMessage[]> {
  const { data: messages } = await supabase
    .from('messages')
    .select('direction, body, sender_type')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(20)

  const history: ConversationMessage[] = (messages || []).map((m: Record<string, string>) => ({
    role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: m.body,
  }))

  // Add the new inbound message with prompt injection protection
  const injectionCheck = detectPromptInjection(newMessage)
  const safeContent = injectionCheck.isClean ? newMessage : injectionCheck.sanitizedText
  history.push({ role: 'user', content: wrapUserContent(safeContent) })

  return history
}

/**
 * Build the full AgentContext needed by the agent system.
 */
async function buildAgentContext(
  supabase: SupabaseClient,
  params: {
    lead: Record<string, unknown>
    conversation: Record<string, unknown>
    conversation_id: string
    organization_id: string
    channel: 'sms' | 'email'
    history: ConversationMessage[]
  }
): Promise<AgentContext> {
  const { lead, conversation, conversation_id, organization_id, channel, history } = params

  // Fetch patient profile and handoff history
  const patientProfileRaw = await getPatientProfile(supabase, lead.id as string)
  const patientProfile = patientProfileRaw as PatientProfile | null
  const handoffHistory = await getHandoffHistory(supabase, conversation_id)

  return {
    lead,
    conversation_id,
    organization_id,
    channel: channel as ConversationChannel,
    lead_status: lead.status as LeadStatus,
    patient_profile: patientProfile,
    conversation_history: history,
    handoff_history: handoffHistory,
    message_count: (conversation.message_count as number) || history.length,
  }
}

/**
 * Send the agent's response via the appropriate channel and store it.
 */
async function sendAgentResponse(
  supabase: SupabaseClient,
  params: {
    organization_id: string
    conversation_id: string
    lead_id: string
    lead: Record<string, unknown>
    channel: 'sms' | 'email'
    sender_contact: string
    agentResponse: AgentResponse
  }
): Promise<void> {
  const { organization_id, conversation_id, lead_id, channel, sender_contact, agentResponse } = params
  let externalId: string | undefined

  if (channel === 'sms') {
    const result = await sendSMS(sender_contact, agentResponse.message)
    externalId = result.sid
  } else {
    const email = decryptField(sender_contact) || sender_contact
    await sendEmail({
      to: email,
      subject: 'Following up on your consultation',
      html: `<div style="font-family: -apple-system, sans-serif; padding: 24px;">${agentResponse.message.replace(/\n/g, '<br>')}</div>`,
      text: agentResponse.message,
    })
  }

  // Store outbound message
  await supabase.from('messages').insert({
    organization_id,
    conversation_id,
    lead_id,
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
    },
  })

  // Update conversation stats
  await supabase.rpc('increment_conversation_counters', {
    p_conversation_id: conversation_id,
    p_last_message_preview: agentResponse.message.substring(0, 100),
  })

  // Update lead last_contacted_at
  await supabase
    .from('leads')
    .update({ last_contacted_at: new Date().toISOString() })
    .eq('id', lead_id)
}

/**
 * Handle opt-out / stop word detection.
 * Opts out the lead, sends confirmation, and creates an escalation.
 */
async function handleStopWord(
  supabase: SupabaseClient,
  params: {
    organization_id: string
    conversation_id: string
    lead_id: string
    lead: Record<string, unknown>
  },
  stopWord: string,
  channel: 'sms' | 'email'
): Promise<void> {
  const { organization_id, conversation_id, lead_id, lead } = params

  // Opt out the lead
  const optOutUpdate: Record<string, unknown> = {}
  if (channel === 'sms') {
    optOutUpdate.sms_opt_out = true
    optOutUpdate.sms_opt_out_at = new Date().toISOString()
  } else {
    optOutUpdate.email_opt_out = true
    optOutUpdate.email_opt_out_at = new Date().toISOString()
  }

  await supabase.from('leads').update(optOutUpdate).eq('id', lead_id)

  // Disable AI on the conversation
  await supabase
    .from('conversations')
    .update({ ai_enabled: false, ai_mode: 'off' })
    .eq('id', conversation_id)

  // Send opt-out confirmation
  if (channel === 'sms' && lead.phone_formatted) {
    const phone = decryptField(lead.phone_formatted as string) || lead.phone_formatted as string
    await sendSMS(phone, 'You have been unsubscribed. You will no longer receive messages from us. Reply START to resubscribe.')
      .catch(() => { /* Confirmation failure shouldn't block */ })
  }

  // Create escalation so staff knows
  await createEscalation(supabase, {
    organization_id,
    conversation_id,
    lead_id,
    reason: 'stop_word_detected',
    ai_notes: `Patient sent "${stopWord}". Auto-opted out of ${channel}. AI disabled on conversation.`,
  })

  // HIPAA audit log
  await logHIPAAEvent(supabase, {
    organization_id,
    event_type: 'consent_revoked',
    severity: 'warning',
    actor_type: 'webhook',
    resource_type: 'lead',
    resource_id: lead_id,
    description: `Patient opted out via stop word "${stopWord}" on ${channel}`,
    metadata: { stop_word: stopWord, channel },
  })

  logger.info('Patient opted out via stop word', { lead_id, channel, stop_word: stopWord })
}
