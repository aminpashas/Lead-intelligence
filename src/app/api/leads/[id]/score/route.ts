import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { scoreLead } from '@/lib/ai/scoring'

// POST /api/leads/[id]/score - Score a lead with AI
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  // Auth + org scoping
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get lead data — scoped to org
  const { data: lead, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', id)
    .eq('organization_id', profile.organization_id)
    .single()

  if (error || !lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  try {
    const scoreResult = await scoreLead(lead)

    // Update lead with score
    await supabase
      .from('leads')
      .update({
        ai_score: scoreResult.total_score,
        ai_qualification: scoreResult.qualification,
        ai_score_breakdown: {
          dimensions: scoreResult.dimensions,
          confidence: scoreResult.confidence,
        },
        ai_score_updated_at: new Date().toISOString(),
        ai_summary: scoreResult.summary,
      })
      .eq('id', id)

    // Log activity
    await supabase.from('lead_activities').insert({
      organization_id: lead.organization_id,
      lead_id: id,
      activity_type: 'score_updated',
      title: `AI Score: ${scoreResult.total_score}/100 (${scoreResult.qualification})`,
      description: scoreResult.summary,
      metadata: scoreResult,
    })

    // Log AI interaction
    await supabase.from('ai_interactions').insert({
      organization_id: lead.organization_id,
      lead_id: id,
      interaction_type: 'scoring',
      model: 'claude-sonnet-4-20250514',
      output_summary: `Score: ${scoreResult.total_score}, Qualification: ${scoreResult.qualification}`,
      success: true,
    })

    return NextResponse.json({ score: scoreResult })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Scoring failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
