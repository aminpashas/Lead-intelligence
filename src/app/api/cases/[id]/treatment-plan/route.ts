import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/permissions'

/**
 * POST /api/cases/[id]/treatment-plan — Doctor creates treatment plan
 */

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()

  if (!profile || !hasPermission(profile.role, 'cases:diagnose')) {
    return NextResponse.json({ error: 'Access denied: doctor role required' }, { status: 403 })
  }

  const body = await request.json()
  const { plan_summary, items, total_estimated_cost, estimated_duration, phases, alternative_options } = body

  if (!plan_summary || !items || items.length === 0) {
    return NextResponse.json({ error: 'plan_summary and items are required' }, { status: 400 })
  }

  // Upsert treatment plan
  const { data: plan, error } = await supabase
    .from('case_treatment_plans')
    .upsert({
      case_id: caseId,
      organization_id: profile.organization_id,
      plan_summary,
      items,
      total_estimated_cost: total_estimated_cost || null,
      estimated_duration: estimated_duration || null,
      phases: phases || 1,
      alternative_options: alternative_options || [],
      planned_by: user.id,
    }, {
      onConflict: 'case_id',
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Move case to patient_review
  await supabase
    .from('clinical_cases')
    .update({
      status: 'patient_review',
      treatment_planned_at: new Date().toISOString(),
    })
    .eq('id', caseId)

  return NextResponse.json({ treatment_plan: plan })
}
