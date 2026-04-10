import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// GET /api/ai/technique-stats — Sales technique usage statistics
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: profile } = await supabase.from('user_profiles').select('organization_id').single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const conversationId = request.nextUrl.searchParams.get('conversation_id')
  const leadId = request.nextUrl.searchParams.get('lead_id')

  // If requesting for a specific conversation
  if (conversationId) {
    const [summaryResult, trackingResult, assessmentsResult] = await Promise.all([
      supabase
        .from('conversation_technique_summaries')
        .select('*')
        .eq('conversation_id', conversationId)
        .single(),
      supabase
        .from('message_technique_tracking')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(200),
      supabase
        .from('lead_engagement_assessments')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('message_index', { ascending: true })
        .limit(100),
    ])

    return NextResponse.json({
      summary: summaryResult.data,
      techniques: trackingResult.data || [],
      assessments: assessmentsResult.data || [],
    })
  }

  // If requesting for a specific lead (across all conversations)
  if (leadId) {
    const [trackingResult, assessmentsResult, summariesResult] = await Promise.all([
      supabase
        .from('message_technique_tracking')
        .select('*')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: true })
        .limit(200),
      supabase
        .from('lead_engagement_assessments')
        .select('*')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: true })
        .limit(100),
      supabase
        .from('conversation_technique_summaries')
        .select('*')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false })
        .limit(50),
    ])

    return NextResponse.json({
      techniques: trackingResult.data || [],
      assessments: assessmentsResult.data || [],
      conversation_summaries: summariesResult.data || [],
    })
  }

  // Organization-level aggregate stats
  const [techniquesResult, summariesResult, recentAssessments] = await Promise.all([
    supabase
      .from('message_technique_tracking')
      .select('technique_id, technique_category, predicted_effectiveness')
      .eq('organization_id', profile.organization_id)
      .order('created_at', { ascending: false })
      .limit(500),
    supabase
      .from('conversation_technique_summaries')
      .select('*')
      .eq('organization_id', profile.organization_id)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('lead_engagement_assessments')
      .select('engagement_temperature, resistance_level, buying_readiness, emotional_state, created_at')
      .eq('organization_id', profile.organization_id)
      .order('created_at', { ascending: false })
      .limit(100),
  ])

  // Compute aggregate stats
  const techniques = techniquesResult.data || []
  const byTechnique: Record<string, { total: number; effective: number; neutral: number; backfired: number }> = {}
  const byCategory: Record<string, number> = {}

  for (const t of techniques) {
    if (!byTechnique[t.technique_id]) {
      byTechnique[t.technique_id] = { total: 0, effective: 0, neutral: 0, backfired: 0 }
    }
    byTechnique[t.technique_id].total++
    if (t.predicted_effectiveness === 'effective') byTechnique[t.technique_id].effective++
    if (t.predicted_effectiveness === 'neutral') byTechnique[t.technique_id].neutral++
    if (t.predicted_effectiveness === 'backfired') byTechnique[t.technique_id].backfired++

    byCategory[t.technique_category] = (byCategory[t.technique_category] || 0) + 1
  }

  // Top and bottom techniques by effectiveness rate
  const techniqueEffectiveness = Object.entries(byTechnique)
    .map(([id, stats]) => ({
      technique_id: id,
      ...stats,
      effectiveness_rate: stats.total > 0 ? stats.effective / stats.total : 0,
    }))
    .sort((a, b) => b.effectiveness_rate - a.effectiveness_rate)

  return NextResponse.json({
    total_technique_uses: techniques.length,
    by_technique: byTechnique,
    by_category: byCategory,
    top_techniques: techniqueEffectiveness.slice(0, 5),
    bottom_techniques: techniqueEffectiveness.slice(-5).reverse(),
    conversation_summaries: summariesResult.data || [],
    recent_assessments: recentAssessments.data || [],
  })
}
