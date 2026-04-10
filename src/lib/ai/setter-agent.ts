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
} from './agent-types'

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

Priority order for unknowns: dental_condition > timeline > financing > decision_makers`,
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
You represent the practice (never share a personal name). You handle initial outreach, lead qualification, and consultation booking via ${context.channel === 'sms' ? 'text message' : 'email'}.

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

═══ COMMUNICATION RULES ═══

${context.channel === 'sms' ? `- SMS: Keep messages under 300 characters. Be conversational, not formal.
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

═══ HANDOFF DETECTION ═══

If ANY of these are true, include "should_handoff": true in your response:
- Patient mentions they already had their consultation
- Patient asks about their specific treatment plan or case-specific pricing
- Patient asks about post-consultation financing details
- The lead status indicates they're past your stage (consultation_completed, treatment_presented, etc.)

═══ OUTPUT FORMAT ═══

Respond with ONLY valid JSON (no markdown, no code blocks):
{
  "message": "your response to the patient",
  "action_taken": "${skill === 'speed_to_lead' ? 'greeted' : skill === 'natural_qualification' ? 'asked_qualifying_question' : skill === 'rapport_building' ? 'built_rapport' : skill === 'appointment_scheduling' ? 'attempted_scheduling' : 'responded'}",
  "should_handoff": false,
  "handoff_reason": null,
  "internal_notes": "brief note about your reasoning and what to do next (staff-visible only)"
}`
}

// ════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ════════════════════════════════════════════════════════════════

export async function setterAgentRespond(
  supabase: SupabaseClient,
  context: AgentContext
): Promise<AgentResponse> {
  const systemPrompt = buildSetterSystemPrompt(context)

  // Scrub PHI from conversation history
  const safeHistory = context.conversation_history.map((msg) => ({
    role: msg.role as 'user' | 'assistant',
    content: scrubPHI(msg.content),
  }))

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: context.channel === 'sms' ? 512 : 1024,
    system: systemPrompt,
    messages: safeHistory,
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''

  // Parse JSON response
  let parsed: {
    message: string
    action_taken: string
    should_handoff: boolean
    handoff_reason: string | null
    internal_notes: string | null
  }

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { message: text, action_taken: 'responded', should_handoff: false, handoff_reason: null, internal_notes: null }
  } catch {
    parsed = { message: text, action_taken: 'responded', should_handoff: false, handoff_reason: null, internal_notes: null }
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
    model: 'claude-sonnet-4-20250514',
    prompt_tokens: response.usage?.input_tokens || 0,
    completion_tokens: response.usage?.output_tokens || 0,
    success: true,
    metadata: {
      agent: 'setter',
      action: parsed.action_taken,
      channel: context.channel,
      should_handoff: parsed.should_handoff,
    },
  }) // Non-critical logging

  return {
    message: finalMessage,
    confidence: hasCriticalIssue ? 0.5 : 0.85,
    agent: 'setter',
    action_taken: (parsed.action_taken || 'responded') as AgentResponse['action_taken'],
    should_handoff: parsed.should_handoff || false,
    handoff_reason: parsed.handoff_reason || undefined,
    internal_notes: parsed.internal_notes || undefined,
  }
}
