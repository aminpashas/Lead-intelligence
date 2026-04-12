import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { scoreLead } from '@/lib/ai/scoring'
import { z } from 'zod'
import { safeParseBody } from '@/lib/body-size'

const bulkActionSchema = z.object({
  lead_ids: z.array(z.string().uuid()).min(1).max(100),
  action: z.enum(['score', 'assign', 'change_status', 'change_stage', 'enroll_campaign', 'disqualify', 'delete']),
  // Params depend on action
  assigned_to: z.string().uuid().optional(),
  status: z.string().optional(),
  stage_id: z.string().uuid().optional(),
  campaign_id: z.string().uuid().optional(),
  disqualified_reason: z.string().optional(),
})

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: body, error: bodyError } = await safeParseBody(request)
  if (bodyError) return bodyError
  const parsed = bulkActionSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { lead_ids, action } = parsed.data
  const results: Array<{ lead_id: string; success: boolean; error?: string }> = []

  switch (action) {
    case 'score': {
      for (const id of lead_ids) {
        try {
          const { data: lead } = await supabase.from('leads').select('*').eq('id', id).eq('organization_id', profile.organization_id).single()
          if (!lead) { results.push({ lead_id: id, success: false, error: 'Not found' }); continue }

          const score = await scoreLead(lead)
          await supabase.from('leads').update({
            ai_score: score.total_score,
            ai_qualification: score.qualification,
            ai_score_breakdown: { dimensions: score.dimensions, confidence: score.confidence },
            ai_score_updated_at: new Date().toISOString(),
            ai_summary: score.summary,
          }).eq('id', id)

          results.push({ lead_id: id, success: true })
        } catch (err) {
          results.push({ lead_id: id, success: false, error: err instanceof Error ? err.message : 'Failed' })
        }
      }
      break
    }

    case 'assign': {
      const { error } = await supabase
        .from('leads')
        .update({ assigned_to: parsed.data.assigned_to })
        .in('id', lead_ids)
        .eq('organization_id', profile.organization_id)

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      lead_ids.forEach((id) => results.push({ lead_id: id, success: true }))
      break
    }

    case 'change_status': {
      const { error } = await supabase
        .from('leads')
        .update({ status: parsed.data.status })
        .in('id', lead_ids)
        .eq('organization_id', profile.organization_id)

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      lead_ids.forEach((id) => results.push({ lead_id: id, success: true }))
      break
    }

    case 'change_stage': {
      const { error } = await supabase
        .from('leads')
        .update({ stage_id: parsed.data.stage_id })
        .in('id', lead_ids)
        .eq('organization_id', profile.organization_id)

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      lead_ids.forEach((id) => results.push({ lead_id: id, success: true }))
      break
    }

    case 'enroll_campaign': {
      if (!parsed.data.campaign_id) {
        return NextResponse.json({ error: 'campaign_id required' }, { status: 400 })
      }
      for (const id of lead_ids) {
        try {
          await supabase.from('campaign_enrollments').insert({
            organization_id: profile.organization_id,
            campaign_id: parsed.data.campaign_id,
            lead_id: id,
            status: 'active',
            next_step_at: new Date().toISOString(),
          })
          results.push({ lead_id: id, success: true })
        } catch {
          results.push({ lead_id: id, success: false, error: 'Already enrolled or error' })
        }
      }
      break
    }

    case 'disqualify': {
      const { error } = await supabase
        .from('leads')
        .update({
          status: 'disqualified',
          disqualified_reason: parsed.data.disqualified_reason || 'Bulk disqualified',
        })
        .in('id', lead_ids)
        .eq('organization_id', profile.organization_id)

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      lead_ids.forEach((id) => results.push({ lead_id: id, success: true }))
      break
    }

    case 'delete': {
      const { error } = await supabase.from('leads').delete().in('id', lead_ids).eq('organization_id', profile.organization_id)
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      lead_ids.forEach((id) => results.push({ lead_id: id, success: true }))
      break
    }
  }

  return NextResponse.json({
    action,
    total: lead_ids.length,
    success: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  })
}
