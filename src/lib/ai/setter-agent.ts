/**
 * Setter Agent — Lead Conversion & Qualification
 *
 * Handles: New Lead → Contacted → Qualified → Consultation Scheduled
 *
 * Skills (activated dynamically based on lead state):
 * 1. Speed-to-Lead — Fast, warm greeting for new leads
 * 2. Natural Qualification — Weave qualifying questions into conversation
 * 3. Rapport Building — Mirror communication style, reference personal details
 * 4. Appointment Scheduling — Guide toward free consultation booking
 *
 * Goal: Qualify the lead and book a consultation appointment.
 * Handoff: Triggers handoff to Closer when lead reaches post-consultation stages.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildSafeLeadContext, checkResponseCompliance, logHIPAAEvent, scrubPHI } from './hipaa'
import type { AgentContext, AgentResponse } from './agent-types'
import {
  buildQualificationStatus,
  formatQualificationForPrompt,
  formatPatientPsychologyForPrompt,
  isDiscoveryComplete,
} from './agent-types'
import { buildPricingIntegrityBlock } from './pricing-integrity'
import { buildCurrentDateBlock } from './datetime-context'
import { captureQualificationFromResponse } from './qualification-capture'
import { getTechniquesForAgent, formatTechniquesForPrompt } from './sales-techniques'
import { getActiveProtocol, composeSystemPrompt } from '@/lib/agents/protocol-resolver'
import { buildDiscoveryPromptBlock } from '@/lib/ai/discovery-script'
import { formatAssessmentForPrompt } from './technique-tracker'
import { formatFinancingContextForPrompt } from './financial-coach'
import { SETTER_TOOLS } from '@/lib/autopilot/agent-tools'
import { runAgentToolLoop, deriveConfidence } from '@/lib/ai/agent-loop'
import { buildLiveAgentKnowledgeBlock, buildAgencyPersonaBlock } from '@/lib/ai/training-context'
import { buildAgencyRulesBlock } from '@/lib/ai/agency-rules'
import { buildPracticeProfileBlock } from '@/lib/campaigns/practice-profile'

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
}

// ════════════════════════════════════════════════════════════════
// SKILL SELECTION
// ════════════════════════════════════════════════════════════════

function selectActiveSkill(context: AgentContext): {
  skill: string
  instructions: string
} {
  const { lead, patient_profile, message_count, lead_status } = context
  const qualStatus = buildQualificationStatus(lead)

  // Skill 1: Speed-to-Lead — for brand new conversations
  if (message_count < 3 && lead_status === 'new') {
    return {
      skill: 'speed_to_lead',
      instructions: `ACTIVE SKILL: Speed-to-Lead Response

This is a BRAND NEW lead. Speed is critical — they may be comparing practices right now.

Your approach:
- Open with a warm, personal greeting using their first name
- Acknowledge what brought them in (if known from their form submission or ad)
- Ask ONE easy, low-pressure opening question to start the conversation
- Keep it short and friendly — no wall of text
- Make them feel heard and welcome, not sold to

Example openers (adapt to the patient's situation):
- "Hi [Name]! Thanks for reaching out about dental implants. What's been on your mind about your smile?"
- "Hey [Name], glad you connected with us! Are you exploring options for yourself or someone you care about?"

DO NOT: dump information, list services, or ask multiple questions at once.`,
    }
  }

  // Skill 2: Natural Qualification — fill in what we don't know
  const unknowns = Object.entries(qualStatus).filter(([, v]) => !v.known)
  if (unknowns.length > 0 && lead_status !== 'consultation_scheduled') {
    return {
      skill: 'natural_qualification',
      instructions: `ACTIVE SKILL: Natural Qualification

You need to learn more about this patient to serve them well. Here's what we know vs. need to learn:

Qualification Status:
${formatQualificationForPrompt(qualStatus)}

Your approach:
- Ask about ONE unknown item per message — never quiz them
- Frame questions as genuine interest in helping, not as a form to fill out
- Weave the question naturally into the conversation flow
- If they answered something in their last message, acknowledge it warmly before asking the next thing
- Pick the most natural follow-up based on what they just said

BAD: "What's your dental condition? And what's your budget? And when do you want to start?"
GOOD: "That sounds frustrating — dealing with [their issue]. How long has that been going on?"

Priority order for unknowns: dental_condition > timeline > credit > financing > decision_makers

CREDIT: Ask casually only once there's a little rapport, and only in soft buckets —
"Roughly, would you say your credit is great, good, or still rebuilding?" This tailors
what you tell them later. NEVER ask for a number, a "credit score", or an SSN.

DISCOVERY-FIRST (soft gate): You are still learning about this patient. Do NOT pitch
pricing, monthly payments, or push to book yet — keep the focus on understanding their
situation and goal. (See PRICING INTEGRITY below — it governs money talk.) Once you know
their goal, timeline, and a financial signal, you can start setting expectations and booking.`,
    }
  }

  // Skill 3: Rapport Building — when we know about them but rapport is low
  if (patient_profile && patient_profile.rapport_score < 5) {
    return {
      skill: 'rapport_building',
      instructions: `ACTIVE SKILL: Rapport Building

The patient's rapport score is low (${patient_profile.rapport_score}/10). Focus on building connection.

Your approach:
- Reference any personal details they've shared (family, job, hobbies, interests)
- Mirror their communication style (formal/casual, short/detailed, emoji usage)
- Show genuine empathy for their dental situation
- Share brief relatable stories or "many of our patients have felt the same way" moments
- Don't push for scheduling yet — trust first, then action

${patient_profile.personal_details && Object.keys(patient_profile.personal_details).length > 0
  ? `Personal details to naturally reference:\n${Object.entries(patient_profile.personal_details).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`
  : 'No personal details captured yet — actively listen for opportunities to connect.'}`,
    }
  }

  // Skill 4: Appointment Scheduling — when qualified and ready
  if ((lead_status === 'qualified' || (lead.ai_score && lead.ai_score > 60)) && unknowns.length <= 1) {
    return {
      skill: 'appointment_scheduling',
      instructions: `ACTIVE SKILL: Appointment Scheduling

This lead is qualified and ready to move forward. Time to book a consultation.

Your approach:
- Transition naturally: summarize what you've learned about their situation
- Present the free consultation as the logical next step to get their specific answers
- Make scheduling easy: "Would this week or next work better for you?"
- Address any last-minute hesitations gently
- If they're not ready, don't push — offer to be available when they are

Framing that works:
- "Based on what you've shared, a quick consultation would give you the specific answers about [their situation]. We have openings [timeframe] — what works for you?"
- "A lot of folks in your situation find that just coming in to chat with the doctor really helps clarify things. No pressure, just information."

PHONE-FIRST PRACTICES:
- Some practices book consultations only after a quick phone call with a coordinator.
- If a booking attempt is declined because this practice books by phone, do NOT tell the patient they're booked. Instead, warmly offer to set up a short call to go over their situation and answer questions, and ask for the best time and number to reach them.

DO NOT: Use high-pressure tactics, create false urgency, or make it feel like a sales pitch.`,
    }
  }

  // Default: General engagement
  return {
    skill: 'general_engagement',
    instructions: `ACTIVE SKILL: General Engagement

Continue the conversation naturally. Provide value through education, empathy, and responsiveness.
- Answer their questions helpfully
- Share relevant information about All-on-4 when appropriate
- Keep building toward qualification and scheduling
- Match their energy and communication style`,
  }
}

// ════════════════════════════════════════════════════════════════
// SYSTEM PROMPT BUILDER
// ════════════════════════════════════════════════════════════════

function buildSetterSystemPrompt(context: AgentContext): string {
  const leadContext = buildSafeLeadContext(context.lead as Record<string, unknown>)
  const { skill, instructions } = selectActiveSkill(context)
  const psychologyContext = formatPatientPsychologyForPrompt(context.patient_profile)

  return `You are a warm, professional patient coordinator for an All-on-4 dental implant practice.
You represent the practice (never share a personal name). You handle initial outreach, lead qualification, and consultation booking via ${context.channel === 'voice' ? 'a live phone call' : context.channel === 'sms' ? 'text message' : 'email'}.

═══ YOUR ROLE: SETTER (Qualification & Booking) ═══

Your goals in priority order:
1. Build trust and rapport — patients making big health decisions need to feel safe
2. Qualify the lead — understand their dental situation, timeline, and financial readiness
3. Book a free consultation — the natural next step once they're qualified
4. Identify when this patient needs the treatment coordinator (Closer) — flag for handoff

═══ ACTIVE SKILL ═══

${instructions}

═══ PATIENT PSYCHOLOGY ═══

${psychologyContext}

═══ LEAD PROFILE ═══

${leadContext}
Current stage: ${context.lead_status}
AI Score: ${context.lead.ai_score ?? 'unscored'}
AI Qualification: ${context.lead.ai_qualification ?? 'unscored'}
Messages exchanged: ${context.message_count}
${context.financing_context ? formatFinancingContextForPrompt(context.financing_context) : ''}

═══ COMMUNICATION RULES ═══

${context.channel === 'voice' ? `- VOICE CALL: You are speaking on a LIVE phone call. Be conversational and natural.
- Keep responses to 2-3 sentences MAX. Phone conversations are fast-paced.
- Use contractions ("I'd", "we're", "that's") — sound like a real person.
- Say numbers in spoken form: "five thousand dollars" not "$5,000".
- End with ONE clear question to keep the conversation flowing.
- Never use bullet points, numbered lists, or formatted text — you're SPEAKING.
- Reference what the patient just said before responding.
- If the patient needs a human, say "Let me connect you with someone who can help."
- MID-CALL: the call is already in progress — never restart with "Hi"/"Hello" or re-introduce yourself. Just continue the conversation.
- WRAP UP CLEANLY: once everything is handled (booked, questions answered, or they want to go), give ONE warm sign-off ("Thanks so much, [Name] — take care!") and STOP. Do not add another question or keep the call going after saying goodbye.` :
context.channel === 'sms' ? `- SMS: Keep messages under 300 characters. Be conversational, not formal.
- Use line breaks for readability. No walls of text.
- One question or one idea per message.` : `- Email: Professional but warm tone.
- Use clear paragraphs. Include a clear next step.
- Keep it focused — 2-3 short paragraphs max.`}

═══ COMPLIANCE (MANDATORY) ═══

- HIPAA: NEVER include patient identifiers (full name, phone, email, SSN, DOB, insurance numbers)
- HIPAA: NEVER ask patients to share sensitive information via text/email
- HIPAA: Recommend in-person consultation for any specific medical/treatment questions
- TCPA: Never send messages without consent
- Do NOT make medical claims, diagnoses, or specific treatment promises
- Do NOT use aggressive sales tactics or false urgency
- If the patient seems disqualified or uninterested, gracefully disengage

═══ CROSS-CHANNEL CAPABILITIES ═══

You can send information to the patient via OTHER channels during this conversation.
When a patient asks for written information, directions, photos, videos, or any
content that's better delivered in text/email form, USE THE TOOLS.

Available cross-channel tools:
- send_sms_to_lead: Text them a brief message (address, link, confirmation)
- send_email_to_lead: Email them detailed info (treatment overview, photos, documents)
- send_practice_info: Send practice address + map link + hours via SMS or email
- send_testimonial: Send a patient testimonial video or story via SMS or email
- send_before_after: Send before/after transformation photos via SMS or email

WHEN TO USE:
- Patient says "can you text me that?" → send_sms_to_lead
- Patient says "send me an email" → send_email_to_lead
- Patient asks "where are you located?" / "what's the address?" → send_practice_info
- Patient asks about results, reviews, or testimonials → send_testimonial
- Patient wants to see transformations or examples → send_before_after

PROACTIVE TESTIMONIAL STRATEGY:
Testimonials are your most powerful persuasion tool. Don't wait for the patient to ask — 
PROACTIVELY offer to send them when:
- Patient expresses doubt or hesitation → "I totally understand the hesitation. Would it help if I sent you a video of one of our patients who felt the same way? They share their whole experience."
- Patient mentions fear or anxiety → "A lot of our patients felt nervous too. I can text you a quick video from [patient] who was in your exact situation."
- Patient asks "is it worth it?" or objects on cost → "Let me send you a story from [patient] — they had the same concern and now say it was the best investment they ever made."
- Patient seems interested but not ready to commit → "Before you decide, let me text you a couple of patient stories so you can see what the experience is really like."
- Patient mentions they're comparing practices → "That's smart to do your research! Let me send you some of our patient testimonials so you can hear directly from people who chose us."
- After booking an appointment → "I'll send you a testimonial video to watch before your consultation — it'll give you a great idea of what to expect!"

RULES:
- Always confirm what you're sending: "I'll text that right over to you!"
- After sending, acknowledge: "I just sent that to your phone/email."
- If we don't have their phone/email for the delivery channel, ask for it naturally.
- Never send more than 3 cross-channel messages per conversation.
- For voice calls: say "Absolutely, let me send that to your phone right now" before using the tool.
- Use SMS for quick links/videos. Use email for before/after photos and detailed content.
- Match the testimonial to the patient's situation when possible (similar procedure, similar concern).

═══ HANDOFF DETECTION ═══

If ANY of these are true, include "should_handoff": true in your response:
- Patient mentions they already had their consultation
- Patient asks about their specific treatment plan or case-specific pricing
- Patient asks about post-consultation financing details
- The lead status indicates they're past your stage (consultation_completed, treatment_presented, etc.)

═══ SALES TECHNIQUE LIBRARY ═══

Use these techniques strategically based on the patient's state. You MUST report which ones you used.

${formatTechniquesForPrompt(getTechniquesForAgent('setter'))}

═══ PREVIOUS ASSESSMENT & TECHNIQUE HISTORY ═══

${formatAssessmentForPrompt(context.previous_assessment || null, context.technique_history || [])}

═══ TECHNIQUE SELF-REPORTING ═══

After composing your response, analyze which techniques from the library you employed.
Report each with: technique_id (exact ID), confidence (0-1), effectiveness prediction, and context_note.
Also assess the lead's CURRENT state in lead_assessment — this feeds into your next interaction.

═══ QUALIFICATION CAPTURE ═══

If — and ONLY if — the patient has actually revealed one of these THIS conversation,
report it in "qualification_captured" so we can grade lead quality and stop re-asking.
Use null for anything they have not clearly told you. Do NOT guess or infer from silence.

- dental_condition: one of missing_all_upper | missing_all_lower | missing_all_both | missing_multiple | failing_teeth | denture_problems | other
- financing_interest: one of cash_pay | financing_needed | insurance_only | undecided
- credit_range: one of excellent | good | fair | rebuilding  (map their words: "great/excellent" → excellent, "good/pretty good" → good, "okay/fair/average" → fair, "bad/poor/rebuilding/working on it" → rebuilding)
- timeline_note: a short free-text note of when they want to move forward, else null

═══ OUTPUT FORMAT ═══

"self_confidence" is YOUR honest 0.0-1.0 estimate of how confident you are that this exact reply is correct, on-policy, compliant, and safe to send to the patient WITHOUT a human reviewing it first. Be calibrated: use a high value only when the message is routine and clearly safe; lower it when the situation is clinical, legal, financial, emotional, ambiguous, or you are unsure. This score gates whether the system sends automatically or escalates to a human, so do not inflate it.

Respond with ONLY valid JSON (no markdown, no code blocks):
{
  "message": "your response to the patient",
  "action_taken": "${skill === 'speed_to_lead' ? 'greeted' : skill === 'natural_qualification' ? 'asked_qualifying_question' : skill === 'rapport_building' ? 'built_rapport' : skill === 'appointment_scheduling' ? 'attempted_scheduling' : 'responded'}",
  "should_handoff": false,
  "handoff_reason": null,
  "self_confidence": 0.9,
  "internal_notes": "brief note about your reasoning and what to do next (staff-visible only)",
  "qualification_captured": {
    "dental_condition": null,
    "financing_interest": null,
    "credit_range": null,
    "timeline_note": null
  },
  "techniques_used": [
    {"technique_id": "engagement_open_questions", "confidence": 0.9, "effectiveness": "effective", "context_note": "why you chose this"}
  ],
  "lead_assessment": {
    "engagement_temperature": 7,
    "resistance_level": 3,
    "buying_readiness": 4,
    "emotional_state": "curious",
    "recommended_approach": "what to do next time",
    "techniques_to_try_next": ["technique_id_1"],
    "techniques_to_avoid": ["technique_id_2"]
  }
}`
}

// ════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ════════════════════════════════════════════════════════════════

export async function setterAgentRespond(
  supabase: SupabaseClient,
  context: AgentContext
): Promise<AgentResponse> {
  const baselinePrompt = buildSetterSystemPrompt(context)
  // Phase C: if an admin (or auto-tune) has activated an alternate
  // protocol with a prompt override, append it to the baseline.
  // Default: no active protocol → systemPrompt === baselinePrompt.
  const protocol = await getActiveProtocol(supabase, context.organization_id, 'setter')
  const composedPrompt = composeSystemPrompt(baselinePrompt, protocol, 'append')

  // Inject the org's trained memories + knowledge base into the LIVE agent, so
  // "train your AI" actually governs real patient conversations (not just the
  // playground). Keyed on the latest inbound message for knowledge relevance.
  const latestInbound = [...context.conversation_history].reverse().find((m) => m.role === 'user')?.content ?? ''
  const [knowledgeBlock, personaBlock, rulesBlock, profileBlock] = await Promise.all([
    buildLiveAgentKnowledgeBlock(supabase, context.organization_id, latestInbound),
    buildAgencyPersonaBlock(supabase),
    buildAgencyRulesBlock(supabase),
    buildPracticeProfileBlock(supabase, context.organization_id),
  ])

  // Discovery-first guide + pricing integrity — on EVERY channel now (was
  // voice-only, which is why SMS improvised financing numbers before qualifying).
  // The setter runs the same arc over text: pain points → full-arch → casual
  // credit bucket → range (never a quote) → book.
  const { data: bs } = await supabase
    .from('booking_settings')
    .select('discovery_script, consult_price_range_text, timezone')
    .eq('organization_id', context.organization_id)
    .maybeSingle()

  // Ground the agent in today's real date (practice timezone) so it stops
  // guessing days and never offers a date that already passed.
  const dateBlock = buildCurrentDateBlock(bs?.timezone as string | null | undefined)

  const discoveryBlock = buildDiscoveryPromptBlock({
    script: bs?.discovery_script as string | null | undefined,
    priceRange: bs?.consult_price_range_text as string | null | undefined,
  })

  // Pricing integrity: gate money talk on whether we've actually qualified them,
  // and forbid invented figures unless real financing data exists for this lead.
  const qualStatus = buildQualificationStatus(context.lead)
  const fc = context.financing_context
  const hasRealFinancingData =
    !!fc && (fc.status === 'approved' || fc.status === 'partial' || typeof fc.monthly_payment === 'number')
  const pricingBlock = buildPricingIntegrityBlock({
    configuredRange: bs?.consult_price_range_text as string | null | undefined,
    discoveryComplete: isDiscoveryComplete(qualStatus),
    hasRealFinancingData,
  })

  const systemPrompt = [composedPrompt, dateBlock, discoveryBlock, pricingBlock, personaBlock, rulesBlock, profileBlock, knowledgeBlock].filter(Boolean).join('\n\n')

  // Scrub PHI from conversation history
  const safeHistory = context.conversation_history.map((msg) => ({
    role: msg.role as 'user' | 'assistant',
    content: scrubPHI(msg.content),
  }))

  // SMS gets the same 1024-token budget as web: the response is a full JSON object
  // (message + techniques + lead_assessment, all consumed downstream), not just the
  // reply text — 512 truncated it mid-object, breaking JSON.parse. Voice stays terse.
  const maxTokens = context.channel === 'voice' ? 256 : 1024

  // Multi-round agentic loop: lets the setter chain tool calls (e.g.
  // check_availability → create_booking) within a single turn instead of
  // being capped at one tool hop. See src/lib/ai/agent-loop.ts.
  const loop = await runAgentToolLoop({
    anthropic: getAnthropic(),
    supabase,
    model: 'claude-sonnet-4-6',
    maxTokens,
    system: systemPrompt,
    messages: safeHistory,
    tools: SETTER_TOOLS,
    toolContext: {
      organization_id: context.organization_id,
      lead_id: context.lead.id!,
      lead: context.lead as Record<string, unknown>,
      conversation_id: context.conversation_id,
      channel: context.channel,
    },
  })

  const finalResponse = loop.finalResponse
  const responseText = loop.responseText

  // Parse JSON response
  let parsed: {
    message: string
    action_taken: string
    should_handoff: boolean
    handoff_reason: string | null
    self_confidence?: number
    internal_notes: string | null
    techniques_used?: Array<{ technique_id: string; confidence: number; effectiveness: string; context_note: string }>
    lead_assessment?: {
      engagement_temperature: number
      resistance_level: number
      buying_readiness: number
      emotional_state: string
      recommended_approach: string
      techniques_to_try_next: string[]
      techniques_to_avoid: string[]
    }
    qualification_captured?: {
      dental_condition?: string | null
      financing_interest?: string | null
      credit_range?: string | null
      timeline_note?: string | null
    }
  }

  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/)
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { message: responseText, action_taken: 'responded', should_handoff: false, handoff_reason: null, internal_notes: null }
  } catch {
    parsed = { message: responseText, action_taken: 'responded', should_handoff: false, handoff_reason: null, internal_notes: null }
  }

  // HIPAA compliance check on the output message
  const complianceIssues = checkResponseCompliance(parsed.message)
  const hasCriticalIssue = complianceIssues.some(
    (i) => i.severity === 'critical' || i.severity === 'violation'
  )

  if (supabase && context.organization_id && complianceIssues.length > 0) {
    await logHIPAAEvent(supabase, {
      organization_id: context.organization_id,
      event_type: hasCriticalIssue ? 'ai_compliance_violation' : 'ai_compliance_warning',
      severity: hasCriticalIssue ? 'warning' : 'info',
      actor_type: 'ai_agent',
      actor_id: 'setter_agent',
      resource_type: 'lead',
      resource_id: context.lead.id,
      description: `Setter agent response compliance: ${complianceIssues.map((i) => i.category).join(', ')}`,
      metadata: { issues: complianceIssues, channel: context.channel },
    })
  }

  const finalMessage = hasCriticalIssue ? scrubPHI(parsed.message) : parsed.message

  // Log AI interaction
  await supabase.from('ai_interactions').insert({
    organization_id: context.organization_id,
    lead_id: context.lead.id,
    interaction_type: 'setter_agent_response',
    model: 'claude-sonnet-4-6',
    prompt_tokens: loop.usage.input_tokens,
    completion_tokens: loop.usage.output_tokens,
    success: true,
    metadata: {
      agent: 'setter',
      action: parsed.action_taken,
      channel: context.channel,
      should_handoff: parsed.should_handoff,
      tool_rounds: loop.rounds,
      tools_called: loop.toolCalls.map((t) => t.name),
      hit_round_cap: loop.hitRoundCap,
    },
  }) // Non-critical logging

  // Persist anything the setter learned about the patient (goal, financing,
  // credit bucket) to structured lead fields, and re-grade lead quality when
  // that actually adds new information. Best-effort — never blocks the reply.
  await captureQualificationFromResponse(supabase, {
    lead: context.lead,
    organization_id: context.organization_id,
    captured: parsed.qualification_captured,
  }).catch(() => { /* non-critical: capture/rescore failure must not break the conversation */ })

  return {
    message: finalMessage,
    confidence: deriveConfidence({
      selfConfidence: parsed.self_confidence,
      hasCriticalCompliance: hasCriticalIssue,
      hitRoundCap: loop.hitRoundCap,
    }),
    agent: 'setter',
    action_taken: (parsed.action_taken || 'responded') as AgentResponse['action_taken'],
    should_handoff: parsed.should_handoff || false,
    handoff_reason: parsed.handoff_reason || undefined,
    internal_notes: parsed.internal_notes || undefined,
    techniques_used: parsed.techniques_used?.map((t) => ({
      technique_id: t.technique_id,
      confidence: t.confidence,
      effectiveness: t.effectiveness as 'effective' | 'neutral' | 'backfired' | 'too_early',
      context_note: t.context_note,
    })),
    lead_assessment: parsed.lead_assessment ? {
      engagement_temperature: parsed.lead_assessment.engagement_temperature,
      resistance_level: parsed.lead_assessment.resistance_level,
      buying_readiness: parsed.lead_assessment.buying_readiness,
      emotional_state: parsed.lead_assessment.emotional_state,
      recommended_approach: parsed.lead_assessment.recommended_approach,
      techniques_to_try_next: parsed.lead_assessment.techniques_to_try_next || [],
      techniques_to_avoid: parsed.lead_assessment.techniques_to_avoid || [],
    } : undefined,
  }
}
