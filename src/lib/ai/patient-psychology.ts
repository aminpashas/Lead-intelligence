/**
 * Patient Psychology Agent (Sales Intelligence)
 *
 * Analyzes conversations to build deep patient profiles including:
 * - Personality type and communication style
 * - Pain points, desires, and emotional state
 * - Negotiation patterns and price sensitivity
 * - Trust level and rapport indicators
 * - Recommended approach for next interaction
 *
 * This agent has "memory" — it accumulates insights across all
 * conversations with a patient, building a richer profile over time.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildSafeLeadContext, buildSafeConversationHistory, logHIPAAEvent } from './hipaa'

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
}

// ════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════

export type PatientProfile = {
  personality_type: string
  communication_style: string
  decision_making_style: string
  trust_level: string

  emotional_state: string
  anxiety_level: number
  confidence_level: number
  motivation_level: number

  pain_points: Array<{ point: string; severity: number; mentioned_count: number }>
  desires: Array<{ desire: string; importance: number; mentioned_count: number }>
  objections: Array<{ objection: string; severity: number; addressed: boolean; approach_used: string | null }>

  price_sensitivity: number
  urgency_perception: number
  negotiation_style: string
  influence_factors: string[]

  rapport_score: number
  personal_details: Record<string, string>
  preferred_contact_time: string | null
  preferred_channel: string | null
  humor_receptivity: string

  key_moments: Array<{ date: string; type: string; description: string }>

  ai_summary: string
  next_best_action: string
  recommended_tone: string
  topics_to_avoid: string[]
  topics_to_emphasize: string[]
}

export type FollowUpPlan = {
  recommended_channel: 'sms' | 'email' | 'call'
  recommended_timing: string
  recommended_tone: string
  opening_message: string
  talking_points: string[]
  things_to_reference: string[] // personal details to mention for connection
  objections_to_address: string[]
  closing_strategy: string
  backup_approach: string
}

// ════════════════════════════════════════════════════════════════
// SYSTEM PROMPTS
// ════════════════════════════════════════════════════════════════

const PSYCHOLOGY_ANALYSIS_PROMPT = `You are a world-class sales psychologist and dental implant patient communication expert.

Your job is to analyze patient conversations and build a deep psychological profile that helps the practice team connect authentically with each patient. This is NOT about manipulation — it's about understanding what each patient needs to feel safe, heard, and confident enough to make a life-changing health decision.

## What You Analyze

1. **Personality Type** — Are they analytical (need data/facts), driver (want efficiency/results), expressive (emotional/enthusiastic), or amiable (need relationship/trust)?

2. **Communication Style** — Do they write long messages or short? Use emojis? Formal or casual? Ask lots of questions? Need reassurance?

3. **Decision-Making Pattern** — Impulsive (might close same day), methodical (needs research time), consensus-seeking (needs spouse/family approval), or risk-averse (needs extra safety info)?

4. **Emotional State** — What's their dominant emotion right now? Anxious? Hopeful? Frustrated? Embarrassed? Scared? Excited?

5. **Pain Points** — What's actually bothering them? Not just "bad teeth" but the REAL pain: can't eat with family, embarrassed to smile, dating difficulties, physical pain, etc.

6. **Desires** — What do they really want? Often deeper than "new teeth" — it's confidence, normalcy, being able to eat steak, not covering their mouth when they laugh.

7. **Objections** — What's holding them back? Track each objection and whether it's been addressed.

8. **Trust Level** — How much do they trust the practice? Building or declining?

9. **Negotiation Profile** — Price sensitive? Needs urgency? Responds to scarcity? Needs social proof? Influenced by authority?

10. **Personal Connection Points** — Any personal details shared (family, job, hobbies) that can be referenced to build rapport.

## Output Requirements

You MUST output ONLY valid JSON matching the schema provided. Be specific and actionable. Every insight should help the practice team have a better next conversation.

IMPORTANT: Do NOT include any actual patient PHI (phone, email, SSN, insurance numbers, addresses) in your output. Use first names only. Focus on behavioral and psychological insights.`

const FOLLOW_UP_PROMPT = `You are a master sales strategist for an All-on-4 dental implant practice.

Given a patient's psychological profile and conversation history, create a tailored follow-up plan that feels natural and authentic — not scripted or salesy.

Key principles:
- **Match their energy**: If they're casual, be casual. If they're formal, be professional.
- **Reference personal details**: People bond when you remember what matters to them.
- **Address unresolved objections**: Don't ignore the elephant in the room.
- **Lead with value**: Every touchpoint should give them something useful.
- **Time it right**: Contact when they're most likely to respond positively.
- **Build the relationship**: This isn't a transaction — it's a healthcare journey.

IMPORTANT: The follow-up message must be HIPAA compliant. Do not include medical details, insurance information, or other PHI in messages sent via SMS or email. Keep medical discussions for in-office consultations.

Output ONLY valid JSON matching the schema provided.`

// ════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ════════════════════════════════════════════════════════════════

/**
 * Analyze a conversation and update the patient's psychological profile.
 * This is the agent's "learning" function — called after each conversation.
 */
export async function analyzePatientPsychology(
  supabase: SupabaseClient,
  config: {
    organization_id: string
    lead_id: string
    conversation_id: string
    lead: Record<string, unknown>
    messages: Array<{ direction: string; body: string; sender_type: string; created_at: string }>
    existingProfile?: Record<string, unknown> | null
  }
): Promise<PatientProfile> {
  // Build HIPAA-safe context
  const safeLeadContext = buildSafeLeadContext(config.lead)
  const safeHistory = buildSafeConversationHistory(config.messages)

  // Include existing profile for continuity (the "memory")
  const existingProfileContext = config.existingProfile
    ? `\n\n## Existing Patient Profile (from previous conversations)\n${JSON.stringify(config.existingProfile, null, 2)}`
    : '\n\n## No previous profile exists — this is the first analysis.'

  const prompt = `Analyze this patient's conversation and ${config.existingProfile ? 'UPDATE their existing psychological profile' : 'create their initial psychological profile'}.

## Patient Context
${safeLeadContext}
${existingProfileContext}

## Conversation to Analyze
${safeHistory.map((m, i) => `[${m.role === 'user' ? 'PATIENT' : 'STAFF'}] ${m.content}`).join('\n\n')}

## Required Output Schema
{
  "personality_type": "analytical|driver|expressive|amiable",
  "communication_style": "direct|detailed|emotional|reserved|casual|formal",
  "decision_making_style": "impulsive|methodical|consensus-seeking|risk-averse",
  "trust_level": "very_low|low|neutral|high|very_high",
  "emotional_state": "<current dominant emotion>",
  "anxiety_level": <0-10>,
  "confidence_level": <0-10>,
  "motivation_level": <0-10>,
  "pain_points": [{"point": "<specific pain point>", "severity": <1-10>, "mentioned_count": <n>}],
  "desires": [{"desire": "<specific desire>", "importance": <1-10>, "mentioned_count": <n>}],
  "objections": [{"objection": "<specific>", "severity": <1-10>, "addressed": <bool>, "approach_used": "<if addressed, what worked>"}],
  "price_sensitivity": <0-10>,
  "urgency_perception": <0-10>,
  "negotiation_style": "collaborative|competitive|avoidant|accommodating",
  "influence_factors": ["<what motivates them: family, self-image, health, social, practical>"],
  "rapport_score": <0-10>,
  "personal_details": {"<key>": "<value — non-medical personal info shared>"},
  "preferred_contact_time": "<when they respond best, or null>",
  "preferred_channel": "<sms|email|call or null>",
  "humor_receptivity": "high|moderate|low|avoid",
  "key_moments": [{"date": "<ISO>", "type": "breakthrough|setback|insight|connection", "description": "<what happened>"}],
  "ai_summary": "<2-3 sentence psychological summary>",
  "next_best_action": "<specific recommendation for next interaction>",
  "recommended_tone": "<how to approach this patient>",
  "topics_to_avoid": ["<sensitive topics>"],
  "topics_to_emphasize": ["<topics that resonate>"]
}`

  // Log HIPAA event
  await logHIPAAEvent(supabase, {
    organization_id: config.organization_id,
    event_type: 'ai_processing',
    severity: 'info',
    actor_type: 'ai_agent',
    actor_id: 'patient_psychology_agent',
    resource_type: 'conversation',
    resource_id: config.conversation_id,
    description: 'Patient psychology agent analyzing conversation (PHI-scrubbed)',
  })

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: PSYCHOLOGY_ANALYSIS_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse psychology analysis response')

  const profile: PatientProfile = JSON.parse(jsonMatch[0])

  // Save to database
  const { error } = await supabase.from('patient_profiles').upsert({
    organization_id: config.organization_id,
    lead_id: config.lead_id,
    ...profile,
    total_conversations_analyzed: (config.existingProfile?.total_conversations_analyzed as number || 0) + 1,
    last_analyzed_at: new Date().toISOString(),
    analysis_version: (config.existingProfile?.analysis_version as number || 0) + 1,
  }, {
    onConflict: 'lead_id',
  })

  if (error) {
    console.error('Error saving patient profile:', error)
  }

  // Log to ai_interactions
  await supabase.from('ai_interactions').insert({
    organization_id: config.organization_id,
    lead_id: config.lead_id,
    interaction_type: 'classification',
    model: 'claude-sonnet-4-20250514',
    prompt_tokens: response.usage?.input_tokens || 0,
    completion_tokens: response.usage?.output_tokens || 0,
    total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
    output_summary: `Psychology profile: ${profile.personality_type}, trust=${profile.trust_level}, anxiety=${profile.anxiety_level}/10`,
    success: true,
    metadata: {
      agent: 'patient_psychology',
      conversation_id: config.conversation_id,
      profile_version: (config.existingProfile?.analysis_version as number || 0) + 1,
    },
  })

  return profile
}

/**
 * Generate a tailored follow-up plan based on the patient's psychology.
 * This is where the "memory" pays off — deeply personalized outreach.
 */
export async function generateTailoredFollowUp(
  supabase: SupabaseClient,
  config: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    profile: PatientProfile
    recentMessages: Array<{ direction: string; body: string; sender_type: string; created_at: string }>
    channel: 'sms' | 'email' | 'call'
    context?: string // additional context like "patient missed appointment" or "financing was denied"
  }
): Promise<FollowUpPlan> {
  const safeLeadContext = buildSafeLeadContext(config.lead)
  const safeHistory = buildSafeConversationHistory(config.recentMessages.slice(-10))

  const prompt = `Generate a tailored follow-up plan for this patient.

## Patient Psychology Profile
${JSON.stringify(config.profile, null, 2)}

## Patient Context
${safeLeadContext}

## Recent Conversation
${safeHistory.map((m) => `[${m.role === 'user' ? 'PATIENT' : 'STAFF'}] ${m.content}`).join('\n\n')}

${config.context ? `## Additional Context\n${config.context}` : ''}

## Channel
${config.channel}

## Required Output Schema
{
  "recommended_channel": "sms|email|call",
  "recommended_timing": "<specific timing recommendation>",
  "recommended_tone": "<how to approach>",
  "opening_message": "<ready-to-send opening message tailored to this patient's style, personality, and current state — ${config.channel === 'sms' ? 'keep under 300 chars' : 'professional email tone'}>",
  "talking_points": ["<specific points to make>"],
  "things_to_reference": ["<personal details to mention for connection>"],
  "objections_to_address": ["<unresolved objections to tackle>"],
  "closing_strategy": "<how to ask for the next commitment>",
  "backup_approach": "<if initial approach doesn't work>"
}`

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    system: FOLLOW_UP_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse follow-up plan response')

  const plan: FollowUpPlan = JSON.parse(jsonMatch[0])

  // Log the follow-up generation
  await supabase.from('ai_interactions').insert({
    organization_id: config.organization_id,
    lead_id: config.lead_id,
    interaction_type: 'engagement',
    model: 'claude-sonnet-4-20250514',
    prompt_tokens: response.usage?.input_tokens || 0,
    completion_tokens: response.usage?.output_tokens || 0,
    total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
    output_summary: `Follow-up plan: ${plan.recommended_channel} at ${plan.recommended_timing}, tone=${plan.recommended_tone}`,
    success: true,
    metadata: {
      agent: 'patient_psychology',
      type: 'follow_up_plan',
      channel: config.channel,
    },
  })

  return plan
}

/**
 * Get the current patient profile from the database.
 */
export async function getPatientProfile(
  supabase: SupabaseClient,
  leadId: string
): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .from('patient_profiles')
    .select('*')
    .eq('lead_id', leadId)
    .single()

  return data
}
