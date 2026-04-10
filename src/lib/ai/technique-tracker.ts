/**
 * Technique Tracker — Storage and Aggregation
 *
 * Stores per-message technique usage, lead assessments,
 * and maintains conversation-level summaries.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getTechniqueById, TECHNIQUE_CATEGORIES, type TechniqueUsage, type LeadEngagementAssessment, type TechniqueCategory } from './sales-techniques'

export async function storeTechniqueUsage(
  supabase: SupabaseClient,
  data: {
    organization_id: string
    conversation_id: string
    lead_id: string
    message_index: number
    agent_type: 'setter' | 'closer'
    techniques: TechniqueUsage[]
  }
): Promise<void> {
  if (!data.techniques || data.techniques.length === 0) return

  const rows = data.techniques
    .map((t) => {
      const technique = getTechniqueById(t.technique_id)
      if (!technique) return null
      return {
        organization_id: data.organization_id,
        conversation_id: data.conversation_id,
        lead_id: data.lead_id,
        message_index: data.message_index,
        agent_type: data.agent_type,
        technique_id: t.technique_id,
        technique_category: technique.category,
        technique_confidence: t.confidence,
        predicted_effectiveness: t.effectiveness,
        context_note: t.context_note,
      }
    })
    .filter(Boolean)

  if (rows.length === 0) return

  await supabase.from('message_technique_tracking').insert(rows)
}

export async function storeLeadAssessment(
  supabase: SupabaseClient,
  data: {
    organization_id: string
    conversation_id: string
    lead_id: string
    message_index: number
    assessment: LeadEngagementAssessment
  }
): Promise<void> {
  await supabase.from('lead_engagement_assessments').insert({
    organization_id: data.organization_id,
    conversation_id: data.conversation_id,
    lead_id: data.lead_id,
    message_index: data.message_index,
    engagement_temperature: data.assessment.engagement_temperature,
    resistance_level: data.assessment.resistance_level,
    buying_readiness: data.assessment.buying_readiness,
    emotional_state: data.assessment.emotional_state,
    recommended_approach: data.assessment.recommended_approach,
    techniques_to_try_next: data.assessment.techniques_to_try_next,
    techniques_to_avoid: data.assessment.techniques_to_avoid,
  })
}

export async function updateConversationSummary(
  supabase: SupabaseClient,
  conversationId: string,
  orgId: string,
  leadId: string
): Promise<void> {
  // Fetch all technique tracking for this conversation
  const { data: allTechniques } = await supabase
    .from('message_technique_tracking')
    .select('technique_id, technique_category, predicted_effectiveness')
    .eq('conversation_id', conversationId)

  if (!allTechniques || allTechniques.length === 0) return

  // Build breakdowns
  const techniquesBreakdown: Record<string, { count: number; effective: number; neutral: number; backfired: number }> = {}
  const categoryBreakdown: Record<string, number> = {}
  const uniqueTechniques = new Set<string>()
  const usedCategories = new Set<string>()

  for (const t of allTechniques) {
    uniqueTechniques.add(t.technique_id)
    usedCategories.add(t.technique_category)

    if (!techniquesBreakdown[t.technique_id]) {
      techniquesBreakdown[t.technique_id] = { count: 0, effective: 0, neutral: 0, backfired: 0 }
    }
    techniquesBreakdown[t.technique_id].count++
    if (t.predicted_effectiveness === 'effective') techniquesBreakdown[t.technique_id].effective++
    if (t.predicted_effectiveness === 'neutral') techniquesBreakdown[t.technique_id].neutral++
    if (t.predicted_effectiveness === 'backfired') techniquesBreakdown[t.technique_id].backfired++

    categoryBreakdown[t.technique_category] = (categoryBreakdown[t.technique_category] || 0) + 1
  }

  // Find most effective technique
  let mostEffective: string | null = null
  let bestEffectiveRate = 0
  for (const [id, stats] of Object.entries(techniquesBreakdown)) {
    const rate = stats.count > 0 ? stats.effective / stats.count : 0
    if (rate > bestEffectiveRate) {
      bestEffectiveRate = rate
      mostEffective = id
    }
  }

  // Diversity score: categories used / total categories
  const diversityScore = usedCategories.size / Object.keys(TECHNIQUE_CATEGORIES).length

  // Get latest engagement assessment for trend
  const { data: assessments } = await supabase
    .from('lead_engagement_assessments')
    .select('engagement_temperature, buying_readiness')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })

  let engagementTrend: 'improving' | 'stable' | 'declining' = 'stable'
  let finalTemp: number | null = null
  let finalReadiness: number | null = null

  if (assessments && assessments.length >= 2) {
    const first = assessments[0]
    const last = assessments[assessments.length - 1]
    finalTemp = last.engagement_temperature
    finalReadiness = last.buying_readiness
    const tempDelta = last.engagement_temperature - first.engagement_temperature
    engagementTrend = tempDelta > 1 ? 'improving' : tempDelta < -1 ? 'declining' : 'stable'
  } else if (assessments && assessments.length === 1) {
    finalTemp = assessments[0].engagement_temperature
    finalReadiness = assessments[0].buying_readiness
  }

  // Adaptation score: did techniques change when resistance increased?
  // Simple heuristic: count distinct techniques used / total messages with techniques
  const adaptationScore = Math.min(1, uniqueTechniques.size / Math.max(1, allTechniques.length) * 2)

  // Upsert summary
  await supabase
    .from('conversation_technique_summaries')
    .upsert({
      organization_id: orgId,
      conversation_id: conversationId,
      lead_id: leadId,
      total_techniques_used: allTechniques.length,
      unique_techniques_used: uniqueTechniques.size,
      techniques_breakdown: techniquesBreakdown,
      category_breakdown: categoryBreakdown,
      most_effective_technique: mostEffective,
      technique_diversity_score: parseFloat(diversityScore.toFixed(2)),
      approach_adaptation_score: parseFloat(adaptationScore.toFixed(2)),
      final_engagement_temperature: finalTemp,
      final_buying_readiness: finalReadiness,
      engagement_trend: engagementTrend,
    }, { onConflict: 'conversation_id' })
}

/**
 * Get the latest lead assessment for injecting into the agent prompt.
 */
export async function getLatestAssessment(
  supabase: SupabaseClient,
  leadId: string
): Promise<LeadEngagementAssessment | null> {
  const { data } = await supabase
    .from('lead_engagement_assessments')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (!data) return null

  return {
    engagement_temperature: data.engagement_temperature,
    resistance_level: data.resistance_level,
    buying_readiness: data.buying_readiness,
    emotional_state: data.emotional_state,
    recommended_approach: data.recommended_approach,
    techniques_to_try_next: data.techniques_to_try_next || [],
    techniques_to_avoid: data.techniques_to_avoid || [],
  }
}

/**
 * Get recent technique history for a lead (last 10 uses).
 */
export async function getRecentTechniqueHistory(
  supabase: SupabaseClient,
  leadId: string
): Promise<Array<{ technique_id: string; predicted_effectiveness: string }>> {
  const { data } = await supabase
    .from('message_technique_tracking')
    .select('technique_id, predicted_effectiveness')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(10)

  return (data || []) as Array<{ technique_id: string; predicted_effectiveness: string }>
}

/**
 * Format the previous assessment and technique history for agent prompts.
 */
export function formatAssessmentForPrompt(
  assessment: LeadEngagementAssessment | null,
  history: Array<{ technique_id: string; predicted_effectiveness: string }>
): string {
  if (!assessment && history.length === 0) {
    return 'No previous assessment available. This is a fresh interaction — assess the lead\'s state from scratch.'
  }

  const lines: string[] = []

  if (assessment) {
    lines.push('PREVIOUS LEAD ASSESSMENT (from your last interaction):')
    lines.push(`Engagement: ${assessment.engagement_temperature}/10 | Resistance: ${assessment.resistance_level}/10 | Buying readiness: ${assessment.buying_readiness}/10`)
    lines.push(`Emotional state: ${assessment.emotional_state}`)
    if (assessment.recommended_approach) {
      lines.push(`Your previous recommended approach: "${assessment.recommended_approach}"`)
    }
    if (assessment.techniques_to_try_next.length > 0) {
      lines.push(`Techniques you recommended trying: ${assessment.techniques_to_try_next.join(', ')}`)
    }
    if (assessment.techniques_to_avoid.length > 0) {
      lines.push(`Techniques to avoid: ${assessment.techniques_to_avoid.join(', ')}`)
    }
  }

  if (history.length > 0) {
    lines.push('')
    lines.push('RECENT TECHNIQUE HISTORY:')
    for (const h of history.slice(0, 5)) {
      const technique = getTechniqueById(h.technique_id)
      lines.push(`- ${technique?.name || h.technique_id} (${h.predicted_effectiveness})`)
    }
  }

  return lines.join('\n')
}
