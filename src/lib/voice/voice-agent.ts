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
// ORG PHONE LOOKUP
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch the organization's main phone number for warm/cold call transfers.
 * Returns undefined if no phone is configured (Retell will end the call gracefully).
 */
async function getOrgTransferNumber(
  supabase: SupabaseClient,
  organizationId: string
): Promise<string | undefined> {
  const { data } = await supabase
    .from('organizations')
    .select('phone')
    .eq('id', organizationId)
    .single()
  return data?.phone || undefined
}

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

    const transferNumber = await getOrgTransferNumber(supabase, organization_id)
    return {
      response: "I apologize, I'm having a little trouble on my end. Let me connect you with someone who can help right away.",
      end_call: false,
      transfer_number: transferNumber,
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

  const transferNumber = shouldTransfer
    ? await getOrgTransferNumber(supabase, organization_id)
    : undefined

  // Hang up when EITHER side has clearly signed off. Two triggers:
  //   1. the agent's own farewell (handled by isVoiceCallEnding), and
  //   2. the PATIENT saying goodbye — the previously-missing case. The caller
  //      controls when a call is over, so "ok thanks, bye" must end it no matter
  //      how the model phrases its reply. Without this the line stayed open,
  //      Retell fired another turn, and the agent re-greeted ("hi…"), looping.
  // Don't end if we're mid-transfer.
  const userSignedOff = isUserEndingCall(latestUserMessage)

  // If the patient signed off but the model is still probing (reply ends on a
  // question), don't hang up on a dangling "?" — give a short, warm close.
  let finalResponse = voiceResponse
  if (userSignedOff && finalResponse.trim().endsWith('?')) {
    const fn = (lead.first_name as string) || ''
    finalResponse = fn
      ? `You got it, ${fn} — thanks so much for your time. Take care!`
      : `You got it — thanks so much for your time. Take care!`
  }

  const endCall = shouldTransfer
    ? false
    : userSignedOff || isVoiceCallEnding(finalResponse, agentResponse.action_taken)

  return {
    response: finalResponse,
    end_call: endCall,
    transfer_number: transferNumber,
    agent: agentResponse.agent,
    confidence: agentResponse.confidence,
    action_taken: agentResponse.action_taken,
  }
}

/**
 * Decide whether this turn should hang up the call.
 *
 * We end when the agent has clearly signed off: a graceful disengagement, or a
 * farewell phrase with NO trailing question. The "no open question" guard keeps
 * ordinary pleasantries that still move the call forward (e.g. "Thanks for
 * calling — how can I help?") from cutting it short. Transfers never end here.
 */
export function isVoiceCallEnding(message: string, action: string): boolean {
  if (action === 'escalated_to_human') return false
  if (action === 'disengaged_gracefully') return true

  const text = message.toLowerCase().trim()
  if (!text || text.endsWith('?')) return false

  const farewells = [
    'take care',
    'have a great day',
    'have a good day',
    'have a wonderful day',
    'rest of your day',
    'goodbye',
    'good bye',
    'bye for now',
    'bye bye',
    'talk to you soon',
    'talk soon',
    "we'll see you",
    'see you then',
    'see you soon',
    'thanks for your time',
    'thank you for your time',
  ]
  return farewells.some((f) => text.includes(f))
}

/**
 * Decide whether the PATIENT (caller) has signed off, so we hang up even if the
 * model's own reply doesn't read as a farewell.
 *
 * WHY THIS EXISTS: the caller — not the agent — controls when a call is over. If
 * the patient says "ok thanks, bye" and the model answers with a fresh question
 * (or, worse, re-greets with "hi…"), the line stays open, Retell fires another
 * turn, and the call loops. Catching the caller's goodbye here breaks that loop.
 *
 * Kept deliberately conservative: we only trip on clear terminal sign-offs, and
 * never when the patient's own line ends on a question (they're still engaged).
 */
export function isUserEndingCall(userMessage: string): boolean {
  const text = userMessage.toLowerCase().trim()
  if (!text || text.endsWith('?')) return false

  // Unambiguous goodbyes — a substring match is safe for these.
  const hardSignoffs = [
    'goodbye',
    'good bye',
    'bye bye',
    'gotta go',
    'got to go',
    'have to go',
    'have to run',
    'need to go',
    'talk to you later',
    'talk to you soon',
    'talk later',
    'talk soon',
    'have a good one',
    'have a great day',
    'have a good day',
    "that's all i needed",
    "that's all for now",
    "i'm all set",
    'im all set',
    "we're all set",
  ]
  if (hardSignoffs.some((p) => text.includes(p))) return true

  // "bye" / "byebye" as a standalone word (not inside "maybe"; "goodbye" handled above).
  if (/\b(bye|byebye)\b/.test(text)) return true

  // Short, clearly-terminal acknowledgements: "ok thanks", "no thanks", "that's it",
  // "all good thanks". Require brevity so a long sentence that merely contains
  // "thanks" doesn't cut the call off.
  const shortClosers = [
    'ok thanks',
    'okay thanks',
    'no thanks',
    "no that's all",
    'nope thanks',
    "that's it",
    'thats it',
    "that's all",
    'thats all',
    'all good thanks',
    "i'm good thanks",
    'im good thanks',
    'thank you so much',
  ]
  const wordCount = text.split(/\s+/).length
  if (wordCount <= 6 && shortClosers.some((p) => text.includes(p))) return true

  return false
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
