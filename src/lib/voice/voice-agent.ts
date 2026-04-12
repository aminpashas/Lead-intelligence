/**
 * Voice Agent — Real-Time Voice ↔ AI Agent Adapter
 *
 * This module bridges the Retell AI voice platform with our existing
 * Setter/Closer agent system. When Retell converts speech → text,
 * it calls our webhook. This module:
 *
 * 1. Receives the transcript from Retell's WebSocket
 * 2. Builds the same AgentContext used by SMS/email agents
 * 3. Routes to Setter or Closer via routeToAgent()
 * 4. Returns the AI response text → Retell converts it to speech
 *
 * Key insight: The AI brain is IDENTICAL for voice, SMS, and email.
 * Only the channel context and response length constraints differ.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { routeToAgent } from '@/lib/ai/agent-handoff'
import { getPatientProfile } from '@/lib/ai/patient-psychology'
import { getHandoffHistory } from '@/lib/ai/agent-handoff'
import { detectPromptInjection, wrapUserContent } from '@/lib/ai/prompt-guard'
import { logHIPAAEvent } from '@/lib/ai/hipaa'
import { getAutopilotConfig, detectStopWord } from '@/lib/autopilot/config'
import { createEscalation } from '@/lib/autopilot/escalation'
import { logger } from '@/lib/logger'
import type { AgentContext, AgentResponse, ConversationMessage } from '@/lib/ai/agent-types'
import type { PatientProfile, LeadStatus } from '@/types/database'
import type { RetellLLMRequest, RetellLLMResponse } from './retell-client'

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type VoiceAgentContext = {
  organization_id: string
  lead_id: string
  lead: Record<string, unknown>
  conversation_id: string
  conversation: Record<string, unknown>
  call_id: string
  direction: 'inbound' | 'outbound'
}

export type VoiceAgentResult = {
  response: string
  end_call: boolean
  transfer_number?: string
  agent: string
  confidence: number
  action_taken: string
}

// ═══════════════════════════════════════════════════════════════
// VOICE-SPECIFIC PROMPT OVERLAY
// ═══════════════════════════════════════════════════════════════

/**
 * Additional instructions injected into the agent's system prompt
 * to adapt its behavior for real-time voice conversation.
 */
const VOICE_CHANNEL_INSTRUCTIONS = `
═══ VOICE CHANNEL RULES (CRITICAL) ═══

You are speaking on a LIVE PHONE CALL, not texting. Follow these rules:

1. BREVITY: Keep responses under 2-3 sentences. Phone conversations are fast-paced.
   BAD: "That's a great question! Let me tell you all about our All-on-4 procedure. It involves four strategically placed implants..."
   GOOD: "Great question! The All-on-4 uses just four implants to give you a full set of permanent teeth. Would you like to know more about the process?"

2. CONVERSATIONAL TONE: Sound natural, like a real person on the phone.
   - Use contractions: "I'd", "we're", "that's"
   - Use filler words sparingly for naturalness: "So,", "Well,", "You know,"
   - Avoid bullet points, numbered lists, or formatted text — you're SPEAKING

3. PACING: End with ONE clear question or prompt to keep the conversation flowing.
   - Don't ask multiple questions at once
   - Pause naturally after important points

4. NUMBERS & FORMATTING:
   - Say "five thousand dollars" not "$5,000"
   - Say "next Tuesday at two thirty" not "Tuesday, 2:30 PM"
   - Spell out abbreviations: "doctor" not "Dr."

5. ACTIVE LISTENING: Reference what the patient just said before responding.
   - "I hear you — dealing with dentures that don't fit is really frustrating."
   - "That makes total sense."

6. WARM TRANSFER: If the patient needs to speak to a human, say:
   "Let me connect you with someone who can help with that right away."
   Then include transfer_to_human: true in your response.

7. COMPLIANCE:
   - This call may be recorded. The greeting has already disclosed this.
   - Never ask for SSN, full DOB, or insurance ID numbers over the phone
   - For sensitive medical details, say "We can go over that in detail at your consultation"

8. END CALL GRACEFULLY: When the conversation is complete or the patient wants to end:
   - Summarize any next steps
   - Thank them warmly
   - Say goodbye naturally: "Thanks so much for chatting, [Name]! We'll see you [day]. Take care!"
`

// ═══════════════════════════════════════════════════════════════
// MAIN VOICE AGENT HANDLER
// ═══════════════════════════════════════════════════════════════

/**
 * Process a real-time voice transcript update from Retell and return
 * the AI agent's response. This is called for every Retell LLM request.
 *
 * Uses the SAME routeToAgent() function as SMS/email — identical brain.
 */
export async function processVoiceTranscript(
  supabase: SupabaseClient,
  retellRequest: RetellLLMRequest,
  voiceContext: VoiceAgentContext
): Promise<VoiceAgentResult> {
  const { organization_id, lead_id, lead, conversation_id, conversation } = voiceContext

  // Handle different interaction types
  if (retellRequest.interaction_type === 'call_details') {
    // First message — return the greeting
    return buildGreeting(supabase, voiceContext)
  }

  if (retellRequest.interaction_type === 'update_only') {
    // Retell is just updating the transcript, no response needed
    return { response: '', end_call: false, agent: 'none', confidence: 1, action_taken: 'listened' }
  }

  // 'response_required' or 'reminder_required' — we need to respond
  const latestUserMessage = retellRequest.transcript
    .filter(t => t.role === 'user')
    .pop()?.content || ''

  if (!latestUserMessage.trim()) {
    // Empty message (silence) — gentle nudge
    if (retellRequest.interaction_type === 'reminder_required') {
      return {
        response: "Are you still there? I'm happy to continue whenever you're ready.",
        end_call: false,
        agent: 'setter',
        confidence: 0.9,
        action_taken: 'reminded',
      }
    }
    return { response: '', end_call: false, agent: 'none', confidence: 1, action_taken: 'waited' }
  }

  // Check for opt-out / stop words
  const config = await getAutopilotConfig(supabase, organization_id)
  const stopCheck = detectStopWord(latestUserMessage, [
    ...config.stop_words,
    'take me off your list',
    'do not call me again',
    "don't call me",
    'remove my number',
  ])

  if (stopCheck.detected) {
    await handleVoiceOptOut(supabase, voiceContext, stopCheck.word!)
    return {
      response: "I completely understand. I've removed your number from our list, and you won't receive any more calls from us. Thank you for your time, and I hope you have a great day.",
      end_call: true,
      agent: 'none',
      confidence: 1,
      action_taken: 'opted_out',
    }
  }

  // Prompt injection detection
  const injectionCheck = detectPromptInjection(latestUserMessage)
  if (!injectionCheck.isClean) {
    logHIPAAEvent(supabase, {
      organization_id,
      event_type: 'prompt_injection_detected',
      severity: 'warning',
      actor_type: 'webhook',
      resource_type: 'voice_call',
      resource_id: voiceContext.call_id,
      description: `Prompt injection detected in voice call transcript`,
      metadata: { detections: injectionCheck.detections },
    }).catch(() => { /* Non-critical */ })
  }

  // Build conversation history from Retell transcript
  const history: ConversationMessage[] = retellRequest.transcript.map(t => ({
    role: t.role === 'user' ? 'user' as const : 'assistant' as const,
    content: t.role === 'user' ? wrapUserContent(t.content) : t.content,
  }))

  // Build agent context — SAME structure used by SMS/email
  const patientProfileRaw = await getPatientProfile(supabase, lead_id)
  const patientProfile = patientProfileRaw as PatientProfile | null
  const handoffHistory = await getHandoffHistory(supabase, conversation_id)

  const agentContext: AgentContext = {
    lead,
    conversation_id,
    organization_id,
    channel: 'voice', // The key difference — voice channel
    lead_status: lead.status as LeadStatus,
    patient_profile: patientProfile,
    conversation_history: history,
    handoff_history: handoffHistory,
    message_count: retellRequest.transcript.length,
  }

  // Route to the SAME agents (Setter/Closer) used by SMS/email
  let agentResponse: AgentResponse
  try {
    agentResponse = await routeToAgent(supabase, agentContext)
  } catch (error) {
    logger.error('Voice agent routing failed', { call_id: voiceContext.call_id }, error instanceof Error ? error : undefined)

    await createEscalation(supabase, {
      organization_id,
      conversation_id,
      lead_id,
      reason: 'agent_failure',
      ai_notes: `Voice agent failed: ${error instanceof Error ? error.message : 'Unknown'}`,
    })

    return {
      response: "I apologize, I'm having a little trouble on my end. Let me connect you with someone who can help right away.",
      end_call: false,
      transfer_number: undefined, // TODO: org's main phone number
      agent: 'none',
      confidence: 0,
      action_taken: 'escalated_to_human',
    }
  }

  // Check if agent wants to hand off to human
  const shouldTransfer = agentResponse.action_taken === 'escalated_to_human' ||
    agentResponse.internal_notes?.includes('transfer_to_human')

  // Adapt the response for voice (the agent already has VOICE_CHANNEL_INSTRUCTIONS)
  // but we do a final cleanup pass
  const voiceResponse = adaptResponseForVoice(agentResponse.message)

  return {
    response: voiceResponse,
    end_call: false,
    transfer_number: shouldTransfer ? undefined : undefined, // TODO: warm transfer number
    agent: agentResponse.agent,
    confidence: agentResponse.confidence,
    action_taken: agentResponse.action_taken,
  }
}

// ═══════════════════════════════════════════════════════════════
// GREETING BUILDER
// ═══════════════════════════════════════════════════════════════

/**
 * Build the initial greeting for a voice call.
 * For outbound: "Hi [Name], this is [Practice] calling..."
 * For inbound: "Thanks for calling [Practice]! How can I help?"
 */
async function buildGreeting(
  supabase: SupabaseClient,
  context: VoiceAgentContext
): Promise<VoiceAgentResult> {
  const { organization_id, lead, direction } = context

  // Get org name
  const { data: org } = await supabase
    .from('organizations')
    .select('name, voice_greeting')
    .eq('id', organization_id)
    .single()

  const practiceName = org?.name || 'our practice'
  const firstName = (lead.first_name as string) || ''

  // Get org voice settings for recording disclosure
  const { data: voiceSettings } = await supabase
    .from('organizations')
    .select('voice_two_party_consent_states')
    .eq('id', organization_id)
    .single()

  // Determine if we need recording disclosure
  const leadState = (lead.state as string)?.toUpperCase()
  const twoPartyStates: string[] = voiceSettings?.voice_two_party_consent_states || []
  const needsRecordingDisclosure = leadState ? twoPartyStates.includes(leadState) : true // Default to yes

  const recordingDisclosure = needsRecordingDisclosure
    ? ' Just so you know, this call may be recorded for quality purposes.'
    : ''

  let greeting: string

  if (direction === 'outbound') {
    // Custom greeting from org settings, or default
    if (org?.voice_greeting) {
      greeting = (org.voice_greeting as string)
        .replace('{practice_name}', practiceName)
        .replace('{first_name}', firstName)
    } else {
      greeting = firstName
        ? `Hi ${firstName}! This is the patient coordinator calling from ${practiceName}.${recordingDisclosure} I'm reaching out about the inquiry you submitted — do you have a quick moment to chat?`
        : `Hi there! This is the patient coordinator calling from ${practiceName}.${recordingDisclosure} Do you have a moment to chat about your recent inquiry?`
    }
  } else {
    // Inbound greeting
    greeting = firstName
      ? `Thanks for calling ${practiceName}! Hi ${firstName}, how can I help you today?${recordingDisclosure}`
      : `Thanks for calling ${practiceName}!${recordingDisclosure} How can I help you today?`
  }

  return {
    response: greeting,
    end_call: false,
    agent: 'setter',
    confidence: 1,
    action_taken: 'greeted',
  }
}

// ═══════════════════════════════════════════════════════════════
// VOICE RESPONSE ADAPTATION
// ═══════════════════════════════════════════════════════════════

/**
 * Post-process the agent's text response to be more voice-friendly.
 * The agent should already write for voice (via VOICE_CHANNEL_INSTRUCTIONS),
 * but this catches any formatting that slipped through.
 */
function adaptResponseForVoice(message: string): string {
  let adapted = message

  // Remove markdown formatting
  adapted = adapted.replace(/\*\*(.*?)\*\*/g, '$1') // bold
  adapted = adapted.replace(/\*(.*?)\*/g, '$1') // italic
  adapted = adapted.replace(/#{1,6}\s/g, '') // headers
  adapted = adapted.replace(/[-*]\s/g, '') // bullet points
  adapted = adapted.replace(/\d+\.\s/g, '') // numbered lists

  // Convert common abbreviations to spoken form
  adapted = adapted.replace(/Dr\./g, 'Doctor')
  adapted = adapted.replace(/vs\./g, 'versus')
  adapted = adapted.replace(/e\.g\./g, 'for example')
  adapted = adapted.replace(/i\.e\./g, 'that is')
  adapted = adapted.replace(/etc\./g, 'and so on')

  // Convert dollar amounts to spoken form
  adapted = adapted.replace(/\$(\d{1,3}),(\d{3})/g, (_match, thousands, hundreds) => {
    return `${thousands} thousand ${parseInt(hundreds) > 0 ? hundreds : ''} dollars`.replace(/\s+/g, ' ').trim()
  })
  adapted = adapted.replace(/\$(\d+)/g, '$1 dollars')

  // Remove URLs (can't speak them naturally)
  adapted = adapted.replace(/https?:\/\/\S+/g, 'the link we can send you')

  // Remove emojis (TTS doesn't handle them)
  adapted = adapted.replace(/[\u{1F600}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|✅|❌|⭐|🔥|💪|👋|📞|📧|🦷|😊|😀|🙏|💰|🏥|📅/gu, '')

  // Clean up excessive whitespace
  adapted = adapted.replace(/\n{2,}/g, '. ')
  adapted = adapted.replace(/\n/g, '. ')
  adapted = adapted.replace(/\s{2,}/g, ' ')
  adapted = adapted.trim()

  return adapted
}

// ═══════════════════════════════════════════════════════════════
// OPT-OUT HANDLER
// ═══════════════════════════════════════════════════════════════

/**
 * Handle opt-out during a voice call.
 * Flags lead as do_not_call, creates escalation, logs HIPAA event.
 */
async function handleVoiceOptOut(
  supabase: SupabaseClient,
  context: VoiceAgentContext,
  stopWord: string
): Promise<void> {
  const { organization_id, conversation_id, lead_id } = context

  // Flag lead as do not call
  await supabase
    .from('leads')
    .update({
      voice_opt_out: true,
      voice_opt_out_at: new Date().toISOString(),
      do_not_call: true,
    })
    .eq('id', lead_id)

  // Disable AI on conversation
  await supabase
    .from('conversations')
    .update({ ai_enabled: false, ai_mode: 'off' })
    .eq('id', conversation_id)

  // Create escalation
  await createEscalation(supabase, {
    organization_id,
    conversation_id,
    lead_id,
    reason: 'stop_word_detected',
    ai_notes: `Patient requested no more calls during voice call (said "${stopWord}"). Marked as Do Not Call.`,
  })

  // HIPAA audit log
  await logHIPAAEvent(supabase, {
    organization_id,
    event_type: 'consent_revoked',
    severity: 'warning',
    actor_type: 'ai_agent',
    resource_type: 'voice_call',
    resource_id: context.call_id,
    description: `Patient opted out during voice call via "${stopWord}". Marked Do Not Call.`,
    metadata: { stop_word: stopWord, channel: 'voice', call_id: context.call_id },
  })

  logger.info('Patient opted out during voice call', {
    lead_id,
    call_id: context.call_id,
    stop_word: stopWord,
  })
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS — Voice channel instructions for agent prompt injection
// ═══════════════════════════════════════════════════════════════

export { VOICE_CHANNEL_INSTRUCTIONS }
