import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { enrichLead } from '@/lib/enrichment'

// POST /api/leads/[id]/enrich - Enrich a single lead on demand
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: lead, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  try {
    const result = await enrichLead(supabase, lead)

    // Optionally re-score after enrichment
    const rescore = new URL(request.url).searchParams.get('rescore')
    if (rescore === 'true') {
      const { scoreLead } = await import('@/lib/ai/scoring')
      const scoreResult = await scoreLead(lead, supabase)
      await supabase
        .from('leads')
        .update({
          ai_score: scoreResult.total_score,
          ai_qualification: scoreResult.qualification,
          ai_score_breakdown: { dimensions: scoreResult.dimensions, confidence: scoreResult.confidence },
          ai_score_updated_at: new Date().toISOString(),
          ai_summary: scoreResult.summary,
        })
        .eq('id', id)
    }

    return NextResponse.json({
      enrichments: result.enrichments,
      enrichment_score: result.enrichment_score,
      summary: result.summary,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Enrichment failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// GET /api/leads/[id]/enrich - Get enrichment data for a lead
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: enrichments, error } = await supabase
    .from('lead_enrichment')
    .select('*')
    .eq('lead_id', id)
    .order('enriched_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ enrichments: enrichments || [] })
}
