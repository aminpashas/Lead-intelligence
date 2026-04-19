import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/permissions'

/**
 * POST /api/cases/[id]/diagnose — Doctor submits diagnosis
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
  const { diagnosis_summary, findings, icd_codes, severity, bone_quality, soft_tissue_status, occlusion_notes, risk_factors } = body

  if (!diagnosis_summary) {
    return NextResponse.json({ error: 'diagnosis_summary is required' }, { status: 400 })
  }

  // Upsert diagnosis (one per case)
  const { data: diagnosis, error } = await supabase
    .from('case_diagnosis')
    .upsert({
      case_id: caseId,
      organization_id: profile.organization_id,
      diagnosis_summary,
      findings: findings || [],
      icd_codes: icd_codes || [],
      severity: severity || 'moderate',
      bone_quality: bone_quality || null,
      soft_tissue_status: soft_tissue_status || null,
      occlusion_notes: occlusion_notes || null,
      risk_factors: risk_factors || [],
      diagnosed_by: user.id,
      diagnosed_at: new Date().toISOString(),
    }, {
      onConflict: 'case_id',
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Move case to treatment_planning
  await supabase
    .from('clinical_cases')
    .update({
      status: 'treatment_planning',
      diagnosed_at: new Date().toISOString(),
    })
    .eq('id', caseId)

  return NextResponse.json({ diagnosis })
}
