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
import { getAgentIdForRole } from '@/lib/agents/agent-resolver'
import { getPatientProfile } from '@/lib/ai/patient-psychology'
import { sendSMS, sendSMSToLead } from '@/lib/messaging/twilio'
import { sendEmailToLead } from '@/lib/messaging/resend'
import { decryptField } from '@/lib/encryption'
import { detectPromptInjection, wrapUserContent } from '@/lib/ai/prompt-guard'
import { logHIPAAEvent } from '@/lib/ai/hipaa'
import { canDisclosePHI } from '@/lib/ai/identity-verification'
import {
  getAutopilotConfig,
  shouldAutoRespond,
  detectStopWord,
  checkMessageRateLimit,
  getLocalHourAndDay,
  resolveConversationAiGate,
  type AutopilotConfig,
} from './config'
import { createEscalation } from './escalation'
import { resolveAutomationOwner, type AllocationDecision } from '@/lib/automation/allocation'
import { applyScopedKnobs } from '@/lib/automation/scoped-config'
import {
  createHumanTask,
  resolveAssignee,
  taskDedupeKeyForInbound,
} from '@/lib/automation/tasks'
import { classifyMedicalQuestion, severityToPriority } from '@/lib/ai/medical-question-detector'
import type { AgentContext, AgentResponse, ConversationMessage } from '@/lib/ai/agent-types'
import type { PatientProfile, ConversationChannel, LeadStatus } from '@/types/database'
import { buildFinancingContext } from '@/lib/ai/financial-coach'
import { getActiveRuleSetStamp } from '@/lib/ai/learning/rule-stamp'
import { logger } from '@/lib/logger'

export type AutoResponseResult = {
  action: 'sent' | 'escalated' | 'skipped' | 'stopped' | 'rate_limited' | 'held_for_human'
  message?: string
  confidence?: number
  agent?: string
  escalation_id?: string | null
  reason?: string
  /** Present when action = 'held_for_human' (Workstream D1 allocation). */
  allocation?: AllocationDecision
  /** Present when action = 'held_for_human' — the created/refreshed human task (D2). */
  task_id?: string | null
}

/**
 * Process an inbound message and auto-respond if autopilot is enabled.
 *
 * `opts.takeover` (Workstream D3): the human-response SLA expired and the
 * sla-takeover cron is re-running this inbound. The D1/D2 allocation hold
 * branch is skipped (we are past the hold), but EVERY other gate still runs —
 * stop words, rate limit, medical question, confidence, assist mode, shadow
 * mode. A gate block escalates/drafts as usual; it never force-sends.
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
  },
  opts?: { takeover?: boolean }
): Promise<AutoResponseResult> {
  const { organization_id, conversation_id, lead_id, lead, conversation, inbound_message, channel, sender_contact } = params

  // 1. Load autopilot config
  const config = await getAutopilotConfig(supabase, organization_id)

  // 1b. Check per-lead AI override
  const leadOverride = (lead.ai_autopilot_override as string) || 'default'

  if (leadOverride === 'force_off') {
    return { action: 'skipped', reason: 'lead_ai_override_off' }
  }

  // 1a. Honor the staff-controlled per-conversation AI mode + per-lead override.
  // 'off' is an explicit instruction to stop autonomous replies on this thread
  // and wins over everything below; 'assist' forces draft+escalate at step 7b.
  const conversationAiMode = (conversation.ai_mode as string) || 'auto'
  const aiGate = resolveConversationAiGate(leadOverride, conversationAiMode)
  if (aiGate === 'silence') {
    return { action: 'skipped', reason: 'conversation_ai_mode_off' }
  }

  // force_on overrides org pause (but NOT kill switch — if enabled is false, that's a kill switch)
  const isKillSwitched = !config.enabled
  if (leadOverride === 'force_on' && !isKillSwitched && config.paused) {
    // Un-pause for this lead only
    config.paused = false
  }

  if (!config.enabled || config.paused) {
    return { action: 'skipped', reason: 'autopilot_disabled' }
  }

  // 2. Check for stop words (opt-out signals)
  const stopCheck = detectStopWord(inbound_message, config.stop_words)
  if (stopCheck.detected) {
    await handleStopWord(supabase, params, stopCheck.word!, channel)
    return { action: 'stopped', reason: `stop_word: ${stopCheck.word}` }
  }

  // 2b. Allocation policy gate (Workstream D1, dormant by default).
  // Runs AFTER the opt-out/STOP check so opt-out processing is never bypassed,
  // and after the conversation/lead AI gates above. With zero policy rows and
  // the org human-first toggle off this always resolves to 'ai' (legacy path).
  // Skipped entirely on an SLA takeover (D3): the hold already ran its course.
  const allocation = opts?.takeover
    ? null
    : await resolveAutomationOwner(supabase, {
        organizationId: organization_id,
        kind: 'inbound_reply',
        stageId: (lead.stage_id as string) || undefined,
      })
  if (allocation && allocation.owner !== 'ai') {
    // D2: the human owns this reply — create (or refresh) the human task so
    // the inbound lands in the /tasks queue. 'hold' = human-first with an SLA
    // before the AI may take over, so due_at carries the deadline (D3 enforces
    // the actual takeover). Task creation fails soft — the AI stands down
    // either way.
    logger.info('Autopilot: inbound reply allocated to human', {
      conversation_id,
      lead_id,
      owner: allocation.owner,
      reason: allocation.reason,
      policy_id: allocation.policyId,
    })

    const rawFirstName = (lead.first_name as string) || ''
    const firstName = decryptField(rawFirstName) || rawFirstName || 'lead'
    const assignee = await resolveAssignee(supabase, organization_id, lead_id)
    const dueAt =
      allocation.owner === 'hold' && allocation.slaSeconds
        ? new Date(Date.now() + allocation.slaSeconds * 1000).toISOString()
        : null

    const { taskId } = await createHumanTask(supabase, {
      organization_id,
      kind: 'inbound_reply',
      title: `Reply to ${firstName}`,
      detail: inbound_message.substring(0, 500),
      source: 'allocation',
      lead_id,
      conversation_id,
      policy_id: allocation.policyId,
      assigned_to: assignee.userId,
      assigned_role: assignee.role,
      due_at: dueAt,
      dedupe_key: taskDedupeKeyForInbound(conversation_id),
      metadata: {
        channel,
        allocation_owner: allocation.owner,
        allocation_reason: allocation.reason,
        sla_seconds: allocation.slaSeconds,
      },
    })

    // Staff notification for this inbound is fired at the webhook layer
    // (webhooks/twilio + webhooks/email-reply call notifyInboundMessage on the
    // held_for_human result) so there is exactly one notify point per inbound.

    return {
      action: 'held_for_human',
      reason: `allocation_${allocation.reason}`,
      allocation,
      task_id: taskId,
    }
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

  // 6. Route to agent and get response.
  // Concurrently classify whether the inbound message is a SPECIFIC MEDICAL
  // QUESTION. Those must never receive an autonomous AI answer — they get
  // escalated to a human (see step 6b). Running the classifier in parallel with
  // agent routing keeps it off the critical latency path. classifyMedicalQuestion
  // never throws (it self-falls-back to a keyword screen on classifier failure),
  // so this promise is always safe to await.
  const recentContext = history
    .slice(-5, -1)
    .map((m) => `${m.role === 'user' ? 'Patient' : 'Us'}: ${m.content}`)
    .join('\n')
  const medicalCheckPromise = classifyMedicalQuestion(inbound_message, {
    recentContext: recentContext || undefined,
  })

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

  // 6b. Clinical-question safety gate. A specific medical question must go to a
  // human — the AI's draft is HELD for staff review (never auto-sent), the
  // escalation is stamped with a severity-derived priority, and the patient gets
  // a non-clinical holding acknowledgment so they aren't left hanging.
  const medical = await medicalCheckPromise
  if (medical.isClinicalQuestion) {
    const priority = severityToPriority(medical.severity)
    const escalationId = await createEscalation(supabase, {
      organization_id,
      conversation_id,
      lead_id,
      reason: 'medical_question_detected',
      ai_notes:
        `Specific medical question detected (${medical.severity}, via ${medical.method}). ` +
        `Categories: ${medical.categories.join(', ') || 'unspecified'}. ${medical.rationale} ` +
        `— AI answer withheld; draft below is for staff review only.`,
      ai_draft_response: agentResponse.message,
      ai_confidence: agentResponse.confidence,
      agent_type: agentResponse.agent,
      priority,
    })

    // Holding acknowledgment (non-clinical). Best-effort — never blocks the
    // escalation. Suppressed in shadow mode to avoid double-texting beside GHL.
    if (!config.outreach_suppressed) {
      await sendHoldingAcknowledgment(supabase, {
        organization_id,
        conversation_id,
        lead_id,
        channel,
        sender_contact,
      }).catch((err) =>
        logger.warn('Medical holding acknowledgment failed', {
          conversation_id,
          channel,
          error: err instanceof Error ? err.message : String(err),
        })
      )
    }

    // HIPAA audit: record that an AI answer to a clinical question was withheld.
    await logHIPAAEvent(supabase, {
      organization_id,
      event_type: 'ai_processing',
      severity: medical.severity === 'urgent' ? 'warning' : 'info',
      actor_type: 'ai_agent',
      actor_id: 'medical_question_detector',
      resource_type: 'conversation',
      resource_id: conversation_id,
      description: `Medical-question gate escalated to human (${medical.severity}); autonomous AI answer withheld.`,
      metadata: { categories: medical.categories, method: medical.method, priority },
    }).catch(() => { /* non-critical */ })

    return {
      action: 'escalated',
      message: agentResponse.message,
      confidence: agentResponse.confidence,
      agent: agentResponse.agent,
      escalation_id: escalationId,
      reason: 'medical_question_detected',
    }
  }

  // 7. Evaluate whether to auto-send.
  // TCPA: quiet-hours must be evaluated in the org's local timezone, not UTC.
  // Scoped knobs: a campaign/stage policy may tighten confidence or hours for
  // this specific reply. Null knobs inherit the org defaults already on config.
  const effectiveConfig = allocation ? applyScopedKnobs(config, allocation) : config
  const { hour: currentHour } = getLocalHourAndDay(config.timezone)
  const messageCount = (conversation.message_count as number) || 0
  const decision = shouldAutoRespond(effectiveConfig, {
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
      reason: mapDecisionReasonToEscalation(decision.reason),
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

  // 7b. Assist mode — generate the draft but never auto-send. Triggered by the
  // per-lead 'assist_only' override OR the per-conversation ai_mode='assist'
  // toggle (resolved into aiGate above).
  if (aiGate === 'assist') {
    const source =
      conversationAiMode === 'assist' && leadOverride !== 'assist_only'
        ? 'Conversation AI mode is set to "assist"'
        : 'Lead has assist_only override'
    const escalationId = await createEscalation(supabase, {
      organization_id,
      conversation_id,
      lead_id,
      reason: 'low_confidence',
      ai_notes: `${source} — AI drafted but not auto-sent.${agentResponse.internal_notes ? ' ' + agentResponse.internal_notes : ''}`,
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
      reason: conversationAiMode === 'assist' && leadOverride !== 'assist_only'
        ? 'conversation_ai_mode_assist'
        : 'lead_assist_only_override',
    }
  }

  // 7c. Shadow mode (cutover safety): the agent draft is fully built and would
  // have been auto-sent, but outreach is suppressed (LI running beside GHL).
  // Route the draft to a human via escalation instead of sending — no double-text.
  if (config.outreach_suppressed) {
    const escalationId = await createEscalation(supabase, {
      organization_id,
      conversation_id,
      lead_id,
      reason: 'compliance_flag',
      ai_notes: `OUTREACH SUPPRESSED (shadow mode): ${agentResponse.internal_notes || 'AI drafted a response that was approved for auto-send but was not delivered.'}`,
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
      reason: 'outreach_suppressed',
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
      takeover: opts?.takeover === true,
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

  // Log prompt injection attempts (MED-4 fix)
  if (!injectionCheck.isClean && supabase) {
    logHIPAAEvent(supabase, {
      organization_id: 'system',
      event_type: 'prompt_injection_detected',
      severity: injectionCheck.detections.some((d: { severity: string }) => d.severity === 'high') ? 'warning' : 'info',
      actor_type: 'webhook',
      resource_type: 'conversation',
      resource_id: conversationId,
      description: `Prompt injection detected in autopilot: ${injectionCheck.detections.map((d: { pattern: string }) => d.pattern).join(', ')}`,
      metadata: { detections: injectionCheck.detections },
    }).catch(() => { /* Non-critical */ })
  }

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

  // Fetch patient profile, handoff history, and financing context in parallel
  const [patientProfileRaw, handoffHistory, financingCtx] = await Promise.all([
    getPatientProfile(supabase, lead.id as string),
    getHandoffHistory(supabase, conversation_id),
    buildFinancingContext(supabase, lead.id as string, organization_id).catch(() => undefined),
  ])
  const patientProfile = patientProfileRaw as PatientProfile | null

  // Phase 4: competitor positioning + bounded negotiation levers, only when the
  // org has competitor_intel on. Failures are non-fatal (context just omits them).
  let competitorContext: import('@/lib/ai/agent-types').CompetitorContext[] | undefined
  let negotiationLevers: string[] | undefined
  try {
    const { isFlagEnabled } = await import('@/lib/org/flags')
    if (await isFlagEnabled(supabase, organization_id, 'competitor_intel')) {
      const { loadCompetitorContext, negotiationLeversForProfile } = await import(
        '@/lib/competitive/context'
      )
      competitorContext = await loadCompetitorContext(supabase, lead.id as string, organization_id)
      negotiationLevers = negotiationLeversForProfile(patientProfile)
    }
  } catch {
    /* non-fatal — agent runs without competitor/negotiation context */
  }

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
    disclose_phi: canDisclosePHI({
      lead,
      verifiedAt: (conversation as Record<string, unknown>).identity_verified_at as string | null,
      channel,
    }),
    financing_context: financingCtx,
    competitor_context: competitorContext && competitorContext.length > 0 ? competitorContext : undefined,
    negotiation_levers: negotiationLevers && negotiationLevers.length > 0 ? negotiationLevers : undefined,
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
    /** D3: this send is an SLA takeover — stamped on the message metadata. */
    takeover?: boolean
  }
): Promise<void> {
  const { organization_id, conversation_id, lead_id, lead, channel, sender_contact, agentResponse, takeover } = params
  let externalId: string | undefined

  // CRIT-1: TCPA consent check enforced inside sendSMSToLead / sendEmailToLead.
  // Gate refusal returns { sent: false } with a logged events row; we throw to escalate.
  if (channel === 'sms') {
    const result = await sendSMSToLead({
      supabase,
      leadId: lead_id,
      to: sender_contact,
      body: agentResponse.message,
      caller: 'autopilot.auto_respond',
      aiGenerated: true,
      blockOnReview: true,
    })
    if (!result.sent) {
      throw new Error(`Cannot send SMS: ${result.reason}`)
    }
    externalId = result.sid
  } else {
    const email = decryptField(sender_contact) || sender_contact
    const result = await sendEmailToLead({
      supabase,
      leadId: lead_id,
      to: email,
      subject: 'Following up on your consultation',
      html: `<div style="font-family: -apple-system, sans-serif; padding: 24px;">${agentResponse.message.replace(/\n/g, '<br>')}</div>`,
      text: agentResponse.message,
      caller: 'autopilot.auto_respond',
      aiGenerated: true,
      blockOnReview: true,
    })
    if (!result.sent) {
      throw new Error(`Cannot send email: ${result.reason}`)
    }
  }
  void lead // (channel/consent state read inside the gate via leadId)

  // Store outbound message. The rule-set stamp records which agency rules were
  // live when this message was generated, so the weekly learning pass can
  // compare outcomes across rule cohorts. Must never block the send path.
  const [agentId, ruleStamp] = await Promise.all([
    getAgentIdForRole(supabase, organization_id, agentResponse.agent),
    getActiveRuleSetStamp(supabase),
  ])
  await supabase.from('messages').insert({
    organization_id,
    conversation_id,
    lead_id,
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
      ...(takeover ? { sla_takeover: true } : {}),
      ...(ruleStamp ? { rule_set: ruleStamp } : {}),
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
 * Fixed, non-clinical acknowledgment sent to a patient when their message is
 * escalated to a human for a medical question. Deliberately contains NO clinical
 * content — it only tells the patient a human is taking over.
 */
const MEDICAL_HOLDING_ACK =
  "Thanks for reaching out — that's an important question, and I want to make sure you get an accurate answer. " +
  "I'm looping in a member of our care team to help, and they'll follow up with you shortly."

/**
 * Send the non-clinical holding acknowledgment and record it on the thread.
 * Throws if the send is blocked (consent/compliance) so the caller can log it;
 * the caller treats delivery as best-effort and never fails the escalation.
 */
async function sendHoldingAcknowledgment(
  supabase: SupabaseClient,
  params: {
    organization_id: string
    conversation_id: string
    lead_id: string
    channel: 'sms' | 'email'
    sender_contact: string
  }
): Promise<void> {
  const { organization_id, conversation_id, lead_id, channel, sender_contact } = params
  let externalId: string | undefined

  if (channel === 'sms') {
    const result = await sendSMSToLead({
      supabase,
      leadId: lead_id,
      to: sender_contact,
      body: MEDICAL_HOLDING_ACK,
      caller: 'autopilot.medical_holding',
      aiGenerated: true,
      blockOnReview: true,
    })
    if (!result.sent) throw new Error(`Holding ack not sent: ${result.reason}`)
    externalId = result.sid
  } else {
    const email = decryptField(sender_contact) || sender_contact
    const result = await sendEmailToLead({
      supabase,
      leadId: lead_id,
      to: email,
      subject: 'We received your question',
      html: `<div style="font-family: -apple-system, sans-serif; padding: 24px;">${MEDICAL_HOLDING_ACK}</div>`,
      text: MEDICAL_HOLDING_ACK,
      caller: 'autopilot.medical_holding',
      aiGenerated: true,
      blockOnReview: true,
    })
    if (!result.sent) throw new Error(`Holding ack not sent: ${result.reason}`)
  }

  // Record the acknowledgment on the thread so staff see it and rate limiting counts it.
  await supabase.from('messages').insert({
    organization_id,
    conversation_id,
    lead_id,
    direction: 'outbound',
    channel,
    body: MEDICAL_HOLDING_ACK,
    sender_type: 'ai',
    status: 'sent',
    external_id: externalId || null,
    ai_generated: true,
    metadata: { holding_ack: true, medical_escalation: true },
  })

  await supabase.rpc('increment_conversation_counters', {
    p_conversation_id: conversation_id,
    p_last_message_preview: MEDICAL_HOLDING_ACK.substring(0, 100),
  })
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

/**
 * Map shouldAutoRespond decision reasons to valid escalation reason enums.
 */
function mapDecisionReasonToEscalation(reason: string): 'low_confidence' | 'compliance_flag' {
  switch (reason) {
    case 'low_confidence':
      return 'low_confidence'
    case 'outside_active_hours':
    case 'review_first_message':
    case 'review_closer_responses':
    case 'no_active_agent':
      return 'compliance_flag'
    default:
      return 'low_confidence'
  }
}
