/**
 * Setter & Closer Agent System — Shared Types
 *
 * Two specialized AI agents handle different funnel stages:
 * - Setter: New Lead → Consultation Scheduled (qualification + booking)
 * - Closer: Consultation Completed → Contract Signed (closing + commitment)
 *
 * The handoff manager routes conversations to the right agent based on
 * the lead's pipeline stage and manages context transfer between agents.
 */

import type { Lead, LeadStatus, PatientProfile, ConversationChannel, FinancingContext } from '@/types/database'
import type { TechniqueUsage, LeadEngagementAssessment } from './sales-techniques'

// ════════════════════════════════════════════════════════════════
// AGENT TYPES
// ════════════════════════════════════════════════════════════════

export type AgentType = 'setter' | 'closer' | 'none'

export type AgentAction =
  | 'responded'
  | 'greeted'
  | 'asked_qualifying_question'
  | 'provided_education'
  | 'handled_objection'
  | 'built_rapport'
  | 'attempted_scheduling'
  | 'confirmed_appointment'
  | 'reinforced_treatment'
  | 'guided_financing'
  | 'created_urgency'
  | 'drove_commitment'
  | 'escalated_to_human'
  | 'disengaged_gracefully'
  | 're_engaged'

export type AgentResponse = {
  message: string
  confidence: number
  agent: AgentType
  action_taken: AgentAction
  should_handoff: boolean
  handoff_reason?: string
  internal_notes?: string
  techniques_used?: TechniqueUsage[]
  lead_assessment?: LeadEngagementAssessment
}

// ════════════════════════════════════════════════════════════════
// CONTEXT TYPES
// ════════════════════════════════════════════════════════════════

export type ConversationMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type HandoffRecord = {
  from_agent: string
  to_agent: string
  trigger_reason: string
  context_snapshot: HandoffContextSnapshot
  created_at: string
}

export type AgentContext = {
  lead: Partial<Lead>
  conversation_id: string
  organization_id: string
  channel: ConversationChannel
  lead_status: LeadStatus
  patient_profile: PatientProfile | null
  conversation_history: ConversationMessage[]
  handoff_history: HandoffRecord[]
  message_count: number
  previous_assessment?: LeadEngagementAssessment | null
  technique_history?: Array<{ technique_id: string; predicted_effectiveness: string }>
  financing_context?: FinancingContext
}

export type HandoffContextSnapshot = {
  patient_psychology_summary: string | null
  addressed_objections: string[]
  unresolved_objections: string[]
  rapport_level: number
  trust_level: string
  key_pain_points: string[]
  conversation_summary: string
  recommended_approach: string | null
  key_moments: Array<{ date: string; type: string; description: string }>
  qualification_data: {
    dental_condition: string | null
    timeline: string | null
    financing_interest: string | null
    budget_range: string | null
    decision_makers_identified: boolean
  }
}

// ════════════════════════════════════════════════════════════════
// STAGE → AGENT MAPPING
// ════════════════════════════════════════════════════════════════

/**
 * Deterministic mapping from pipeline stage to responsible agent.
 * This is the single source of truth for routing — no AI decides routing.
 */
export const STAGE_AGENT_MAP: Record<LeadStatus, AgentType> = {
  // Setter handles: initial outreach through consultation booking
  new: 'setter',
  contacted: 'setter',
  qualified: 'setter',
  consultation_scheduled: 'setter',
  no_show: 'setter',
  unresponsive: 'setter',

  // Closer handles: post-consultation through contract
  consultation_completed: 'closer',
  treatment_presented: 'closer',
  financing: 'closer',
  contract_sent: 'closer',

  // No agent: completed stages
  contract_signed: 'none',
  scheduled: 'none',
  in_treatment: 'none',
  completed: 'none',
  lost: 'none',
  disqualified: 'none',
}

// ════════════════════════════════════════════════════════════════
// QUALIFICATION TRACKING (for Setter)
// ════════════════════════════════════════════════════════════════

export type QualificationStatus = {
  dental_condition: { known: boolean; value: string | null }
  timeline: { known: boolean; value: string | null }
  financing: { known: boolean; value: string | null }
  decision_makers: { known: boolean; value: string | null }
}

/**
 * Extracts what we know vs don't know about a lead's qualification.
 * The Setter uses this to decide which qualifying question to ask next.
 */
export function buildQualificationStatus(lead: Partial<Lead>): QualificationStatus {
  return {
    dental_condition: {
      known: !!lead.dental_condition,
      value: lead.dental_condition || null,
    },
    timeline: {
      known: !!lead.consultation_date || !!lead.treatment_date,
      value: lead.consultation_date
        ? `consultation: ${lead.consultation_date}`
        : lead.treatment_date
          ? `treatment: ${lead.treatment_date}`
          : null,
    },
    financing: {
      known: !!lead.financing_interest,
      value: lead.financing_interest || null,
    },
    decision_makers: {
      known: false, // Can only be determined from conversation context
      value: null,
    },
  }
}

/**
 * Formats qualification status for inclusion in agent prompts.
 */
export function formatQualificationForPrompt(status: QualificationStatus): string {
  const lines: string[] = []

  lines.push(`- Dental condition: ${status.dental_condition.known
    ? `KNOWN — "${status.dental_condition.value}"`
    : 'UNKNOWN — ask naturally in conversation'}`)

  lines.push(`- Timeline/urgency: ${status.timeline.known
    ? `KNOWN — "${status.timeline.value}"`
    : 'UNKNOWN — ask when they want to start'}`)

  lines.push(`- Financing preference: ${status.financing.known
    ? `KNOWN — "${status.financing.value}"`
    : 'UNKNOWN — ask about their budget comfort level'}`)

  lines.push(`- Decision makers: ${status.decision_makers.known
    ? `KNOWN — "${status.decision_makers.value}"`
    : 'UNKNOWN — ask if anyone else is involved in the decision (spouse, family)'}`)

  return lines.join('\n')
}

// ════════════════════════════════════════════════════════════════
// PATIENT PSYCHOLOGY PROMPT HELPERS
// ════════════════════════════════════════════════════════════════

/**
 * Formats patient psychology profile for inclusion in agent system prompts.
 * Used by both Setter and Closer to personalize their communication style.
 */
export function formatPatientPsychologyForPrompt(profile: PatientProfile | null): string {
  if (!profile || !profile.personality_type) {
    return 'No patient psychology profile available yet. Use a warm, neutral tone until you learn more about this person.'
  }

  const lines: string[] = [
    `Personality type: ${profile.personality_type} (${profile.communication_style || 'unknown style'})`,
    `Decision-making: ${profile.decision_making_style || 'unknown'}`,
    `Trust level: ${profile.trust_level} | Rapport score: ${profile.rapport_score}/10`,
    `Emotional state: ${profile.emotional_state} | Anxiety: ${profile.anxiety_level}/10 | Motivation: ${profile.motivation_level}/10`,
  ]

  if (profile.pain_points?.length > 0) {
    const topPains = profile.pain_points.slice(0, 3).map(p => p.point).join(', ')
    lines.push(`Key pain points: ${topPains}`)
  }

  if (profile.desires?.length > 0) {
    const topDesires = profile.desires.slice(0, 3).map(d => d.desire).join(', ')
    lines.push(`Key desires: ${topDesires}`)
  }

  if (profile.recommended_tone) {
    lines.push(`Recommended tone: ${profile.recommended_tone}`)
  }

  if (profile.topics_to_emphasize?.length > 0) {
    lines.push(`Topics to emphasize: ${profile.topics_to_emphasize.join(', ')}`)
  }

  if (profile.topics_to_avoid?.length > 0) {
    lines.push(`Topics to AVOID: ${profile.topics_to_avoid.join(', ')}`)
  }

  if (profile.next_best_action) {
    lines.push(`Recommended next action: ${profile.next_best_action}`)
  }

  return lines.join('\n')
}
