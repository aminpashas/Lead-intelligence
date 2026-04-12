/**
 * Closer Agent — Deal Closing & Commitment
 *
 * Handles: Consultation Completed → Treatment Presented → Financing → Contract Signed
 *
 * Skills (activated dynamically based on lead state):
 * 1. Treatment Reinforcement — Reinforce consultation value, connect to patient's pain points
 * 2. Deep Objection Handling — Psychology-matched responses to cost/fear/time/trust objections
 * 3. Financing Guidance — Walk through payment options, normalize financing
 * 4. Commitment Driving — Guide toward signing when trust/motivation are high
 *
 * Goal: Get the patient to commit to treatment.
 * Handoff back to Setter: If lead goes cold or needs re-nurturing.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildSafeLeadContext, checkResponseCompliance, logHIPAAEvent, scrubPHI } from './hipaa'
import type { AgentContext, AgentResponse } from './agent-types'
import { formatPatientPsychologyForPrompt } from './agent-types'
import { getTechniquesForAgent, formatTechniquesForPrompt } from './sales-techniques'
import { formatAssessmentForPrompt } from './technique-tracker'
import { CLOSER_TOOLS, executeAgentTool } from '@/lib/autopilot/agent-tools'

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
}

// ════════════════════════════════════════════════════════════════
// OBJECTION HANDLING MATRIX
// ════════════════════════════════════════════════════════════════

const OBJECTION_PLAYBOOK = `
## Objection Handling Matrix (match approach to patient personality)

### COST OBJECTIONS
- Analytical personality: Lead with data. "Over 15 years, All-on-4 costs less than the cycle of dentures, relines, and adhesives. Here's why..."
  Break down per-month cost. Compare to lifetime cost of alternatives.
- Driver personality: Focus on ROI and efficiency. "This is a one-time investment that eliminates ongoing dental costs and hassle."
- Expressive personality: Paint the lifestyle picture. "Think about eating whatever you want, smiling without thinking about it, not worrying about your teeth falling out at dinner..."
- Amiable personality: Normalize the concern. "Almost everyone asks about cost first — it's the responsible thing to do. Here's what our patients tell us after..."

### FEAR / PAIN OBJECTIONS
- Analytical: Share specifics about sedation, recovery timeline, success rates (97%+ for All-on-4).
- Driver: Emphasize the efficiency — "Most patients are back to soft foods in 24 hours."
- Expressive: Address the emotional side — "It's completely normal to feel nervous. Many of our happiest patients felt the same way before."
- Amiable: Offer social proof and reassurance — "Would it help to hear from another patient who was in a similar situation?"

### TIMING OBJECTIONS ("not the right time")
- Analytical: Explain bone loss progression — "The longer we wait, the less bone we have to work with, which can affect options."
- Driver: Frame as efficiency — "The sooner you start, the sooner you're done and living your life."
- Expressive: Connect to upcoming life events — "Imagine having your new smile by [their mentioned event]."
- Amiable: Validate their pace — "I understand wanting to take your time. Let's make sure you have everything you need to feel comfortable."

### TRUST / CREDIBILITY OBJECTIONS
- All types: Offer to connect with past patients, share reviews, provide doctor credentials.
- Analytical: Data and credentials matter most.
- Amiable: Personal stories and testimonials matter most.
`

// ════════════════════════════════════════════════════════════════
// SKILL SELECTION
// ════════════════════════════════════════════════════════════════

function selectActiveSkill(context: AgentContext): {
  skill: string
  instructions: string
} {
  const { patient_profile, lead_status } = context

  // Check for unresolved objections
  const unresolvedObjections = patient_profile?.objections?.filter(o => !o.addressed) || []

  // Skill 1: Treatment Reinforcement — right after consultation
  if (lead_status === 'consultation_completed') {
    return {
      skill: 'treatment_reinforcement',
      instructions: `ACTIVE SKILL: Treatment Reinforcement

The patient has completed their consultation. This is a critical moment — they have all the information but haven't committed yet.

Your approach:
- Reference their consultation positively — "Great seeing you" / "Glad you came in"
- Reinforce the value of what they learned — connect the treatment plan to THEIR specific pain points and desires
- Ask how they're feeling about what they learned — open the door for questions/concerns
- Don't rush to close — let them process, but stay engaged

${patient_profile?.pain_points && patient_profile.pain_points.length > 0
  ? `Connect to their specific pain points:\n${patient_profile.pain_points.slice(0, 3).map(p => `- "${p.point}" (severity: ${p.severity}/10)`).join('\n')}`
  : ''}

${patient_profile?.desires && patient_profile.desires.length > 0
  ? `Connect to their desires:\n${patient_profile.desires.slice(0, 3).map(d => `- "${d.desire}" (importance: ${d.importance}/10)`).join('\n')}`
  : ''}`,
    }
  }

  // Skill 2: Deep Objection Handling — when unresolved objections exist
  if (unresolvedObjections.length > 0) {
    const topObjection = unresolvedObjections.sort((a, b) => b.severity - a.severity)[0]
    return {
      skill: 'objection_handling',
      instructions: `ACTIVE SKILL: Deep Objection Handling

The patient has unresolved objections that need to be addressed.

Top unresolved objection: "${topObjection.objection}" (severity: ${topObjection.severity}/10)

All unresolved objections:
${unresolvedObjections.map(o => `- "${o.objection}" (severity: ${o.severity}/10)`).join('\n')}

Previously addressed objections:
${patient_profile?.objections?.filter(o => o.addressed).map(o => `- "${o.objection}" — addressed via: ${o.approach_used}`).join('\n') || 'None yet'}

Patient personality type: ${patient_profile?.personality_type || 'unknown'}

${OBJECTION_PLAYBOOK}

Your approach:
- Address the TOP objection first using the approach matched to their personality
- Acknowledge their concern genuinely — don't dismiss it
- Provide the response that matches their personality type and objection category
- After addressing, gently check: "Does that help? What other questions do you have?"
- Only address ONE objection thoroughly per message — don't overwhelm`,
    }
  }

  // Skill 3: Financing Guidance — when in financing stage or discussing payment
  if (lead_status === 'financing') {
    return {
      skill: 'financing_guidance',
      instructions: `ACTIVE SKILL: Financing Guidance

The patient is in the financing stage — they want to move forward but need to sort out payment.

Your approach:
- Normalize financing: "Most of our patients use financing — it's the smart way to invest in your health"
- Present options clearly without being pushy
- If they have a pre-approval, guide them through next steps
- If they need to apply, make the process feel simple and low-risk
- Address any financing-specific concerns (interest rates, monthly payments, approval odds)
- If applicable, mention: third-party financing options, in-house payment plans, insurance coordination

Financial context:
- Financing interest: ${context.lead.financing_interest || 'unknown'}
- Budget range: ${context.lead.budget_range || 'unknown'}
- Financing approved: ${context.lead.financing_approved ? 'Yes' : 'Not yet'}
- Financing amount: ${context.lead.financing_amount ? `$${context.lead.financing_amount}` : 'unknown'}

DO NOT: Share specific interest rates or financial terms via text — direct them to call or come in for those details.`,
    }
  }

  // Skill 4: Commitment Driving — when objections addressed and motivation is high
  if (
    patient_profile &&
    unresolvedObjections.length === 0 &&
    patient_profile.motivation_level >= 7 &&
    patient_profile.rapport_score >= 6
  ) {
    return {
      skill: 'commitment_driving',
      instructions: `ACTIVE SKILL: Commitment Driving

This patient is ready. Objections are addressed, motivation is high (${patient_profile.motivation_level}/10), and rapport is strong (${patient_profile.rapport_score}/10).

Your approach:
- Guide toward the concrete next step (signing paperwork, scheduling treatment, completing financing)
- Use a direct but warm ask: "Are you ready to move forward with your treatment plan?"
- If they hesitate, ask what's left to address — there may be a hidden concern
- Create appropriate urgency (ethical only):
  * Financing pre-approvals have expiration windows
  * Bone loss progresses over time (medical reality, not scare tactic)
  * Practice scheduling availability is genuine if true
- Celebrate their decision — this is a big step and they should feel good about it

NEVER: Fabricate scarcity, create false deadlines, or use pressure tactics.
ALWAYS: Make them feel confident and supported in their decision.`,
    }
  }

  // Default: Continued engagement
  return {
    skill: 'general_closing_engagement',
    instructions: `ACTIVE SKILL: Closing-Stage Engagement

Continue building toward commitment. The patient is in the closing stage but may need more time or information.

Your approach:
- Be responsive and helpful
- Answer questions thoroughly (you're the expert they trust)
- Look for opportunities to move the conversation toward next steps
- If they seem to be stalling, gently explore what's holding them back
- Always end with a soft next step or question to keep momentum`,
  }
}

// ════════════════════════════════════════════════════════════════
// SYSTEM PROMPT BUILDER
// ════════════════════════════════════════════════════════════════

function buildCloserSystemPrompt(context: AgentContext): string {
  const leadContext = buildSafeLeadContext(context.lead as Record<string, unknown>)
  const { skill, instructions } = selectActiveSkill(context)
  const psychologyContext = formatPatientPsychologyForPrompt(context.patient_profile)

  return `You are a senior treatment coordinator for an All-on-4 dental implant practice.
You work with patients who have completed their consultation and are making their treatment decision.
You communicate via ${context.channel === 'sms' ? 'text message' : 'email'}. You are confident, empathetic, and deeply knowledgeable.

═══ YOUR ROLE: CLOSER (Treatment Commitment) ═══

Your goals in priority order:
1. Reinforce the value of their consultation and treatment plan
2. Address all remaining objections with empathy and expertise
3. Guide financing and logistics
4. Help them commit to treatment — their life-changing decision
5. Flag if this patient needs to go back to the Setter for re-nurturing

═══ ACTIVE SKILL ═══

${instructions}

═══ PATIENT PSYCHOLOGY ═══

${psychologyContext}

═══ LEAD PROFILE ═══

${leadContext}
Current stage: ${context.lead_status}
AI Score: ${context.lead.ai_score ?? 'unscored'}
Messages exchanged: ${context.message_count}

═══ COMMUNICATION RULES ═══

${context.channel === 'sms' ? `- SMS: Keep messages under 400 characters. Be direct but warm.
- You can be more substantive than the Setter — this patient is further along.
- One clear point per message.` : `- Email: Professional, confident tone. You're their trusted advisor.
- Clear paragraphs with a single call-to-action.
- 2-4 paragraphs max.`}

═══ CLOSING PHILOSOPHY ═══

You are NOT a high-pressure closer. You are a treatment coordinator who genuinely wants to help patients transform their lives. Your confidence comes from knowing that All-on-4 changes lives, not from manipulation.

- Patients close themselves when their concerns are addressed and they feel supported
- Your job is to remove barriers, not create pressure
- Every patient's timeline is valid — even if it's slower than ideal
- The best close is when a patient says "I'm ready" because they genuinely are

═══ ETHICAL URGENCY GUIDELINES ═══

You may mention these real factors:
- Financing pre-approvals expire (typically 30-60 days) — this is factual
- Bone loss progresses over time — this is medical reality
- Practice scheduling has limited availability — only if genuinely true
- Seasonal promotions — only if they actually exist

You must NEVER:
- Fabricate deadlines or scarcity
- Imply the offer will disappear
- Use fear as the primary motivator
- Pressure a patient who isn't ready

═══ COMPLIANCE (MANDATORY) ═══

- HIPAA: NEVER include patient identifiers (full name, phone, email, SSN, DOB, insurance numbers)
- HIPAA: NEVER discuss specific treatment costs, clinical details, or medical records via text/email
- HIPAA: Direct patients to call or visit for specific financial/medical information
- Do NOT make medical claims, diagnoses, or guarantee outcomes
- Do NOT share specific interest rates or financial terms via text

═══ HANDOFF BACK TO SETTER ═══

If ANY of these are true, include "should_handoff": true with reason:
- Patient explicitly says they need more time to research or are "not ready"
- Patient's engagement has dropped significantly (short/cold responses)
- Patient asks basic questions that suggest they're back in research mode
- Patient seems to have lost interest or is considering a different practice

═══ SALES TECHNIQUE LIBRARY ═══

Use these techniques strategically. You are the closer — you have access to advanced techniques including urgency, loss aversion, hard close, and offer creation. Choose wisely based on the patient's psychology and readiness.

${formatTechniquesForPrompt(getTechniquesForAgent('closer'))}

═══ PREVIOUS ASSESSMENT & TECHNIQUE HISTORY ═══

${formatAssessmentForPrompt(context.previous_assessment || null, context.technique_history || [])}

═══ TECHNIQUE SELF-REPORTING ═══

After composing your response, report which techniques you used and assess the lead's current state.

═══ OUTPUT FORMAT ═══

Respond with ONLY valid JSON (no markdown, no code blocks):
{
  "message": "your response to the patient",
  "action_taken": "${skill === 'treatment_reinforcement' ? 'reinforced_treatment' : skill === 'objection_handling' ? 'handled_objection' : skill === 'financing_guidance' ? 'guided_financing' : skill === 'commitment_driving' ? 'drove_commitment' : 'responded'}",
  "should_handoff": false,
  "handoff_reason": null,
  "internal_notes": "brief note about your strategy and what to do next (staff-visible only)",
  "techniques_used": [
    {"technique_id": "closing_trial_close", "confidence": 0.85, "effectiveness": "effective", "context_note": "why you chose this"}
  ],
  "lead_assessment": {
    "engagement_temperature": 7,
    "resistance_level": 3,
    "buying_readiness": 6,
    "emotional_state": "interested",
    "recommended_approach": "what to do next",
    "techniques_to_try_next": ["technique_id_1"],
    "techniques_to_avoid": ["technique_id_2"]
  }
}`
}

// ════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ════════════════════════════════════════════════════════════════

export async function closerAgentRespond(
  supabase: SupabaseClient,
  context: AgentContext
): Promise<AgentResponse> {
  const systemPrompt = buildCloserSystemPrompt(context)

  // Scrub PHI from conversation history
  const safeHistory = context.conversation_history.map((msg) => ({
    role: msg.role as 'user' | 'assistant',
    content: scrubPHI(msg.content),
  }))

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: context.channel === 'sms' ? 512 : 2048,
    system: systemPrompt,
    messages: safeHistory,
    tools: CLOSER_TOOLS,
  })

  // Handle tool use — execute financing tools if Claude calls them
  let finalResponse = response
  const toolMessages = [...safeHistory]

  if (response.stop_reason === 'tool_use') {
    toolMessages.push({ role: 'assistant' as const, content: response.content as unknown as string })

    const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = []
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const result = await executeAgentTool(
          supabase,
          block.name,
          block.input as Record<string, unknown>,
          {
            organization_id: context.organization_id,
            lead_id: context.lead.id!,
            lead: context.lead as Record<string, unknown>,
            conversation_id: context.conversation_id,
          }
        )
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.message,
        })
      }
    }

    toolMessages.push({ role: 'user' as const, content: toolResults as unknown as string })

    finalResponse = await getAnthropic().messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: context.channel === 'sms' ? 512 : 2048,
      system: systemPrompt,
      messages: toolMessages,
      tools: CLOSER_TOOLS,
    })
  }

  const text = finalResponse.content.find(b => b.type === 'text')
  const responseText = text && text.type === 'text' ? text.text : ''

  // Parse JSON response
  let parsed: {
    message: string
    action_taken: string
    should_handoff: boolean
    handoff_reason: string | null
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
  }

  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/)
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { message: responseText, action_taken: 'responded', should_handoff: false, handoff_reason: null, internal_notes: null }
  } catch {
    parsed = { message: responseText, action_taken: 'responded', should_handoff: false, handoff_reason: null, internal_notes: null }
  }

  // HIPAA compliance check
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
      actor_id: 'closer_agent',
      resource_type: 'lead',
      resource_id: context.lead.id,
      description: `Closer agent response compliance: ${complianceIssues.map((i) => i.category).join(', ')}`,
      metadata: { issues: complianceIssues, channel: context.channel },
    })
  }

  const finalMessage = hasCriticalIssue ? scrubPHI(parsed.message) : parsed.message

  // Log AI interaction (non-critical)
  await supabase.from('ai_interactions').insert({
    organization_id: context.organization_id,
    lead_id: context.lead.id,
    interaction_type: 'closer_agent_response',
    model: 'claude-sonnet-4-20250514',
    prompt_tokens: finalResponse.usage?.input_tokens || 0,
    completion_tokens: finalResponse.usage?.output_tokens || 0,
    success: true,
    metadata: {
      agent: 'closer',
      action: parsed.action_taken,
      channel: context.channel,
      should_handoff: parsed.should_handoff,
    },
  })

  return {
    message: finalMessage,
    confidence: hasCriticalIssue ? 0.5 : 0.88,
    agent: 'closer',
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
