import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * GET /api/cases/patient/[shareToken] — Public endpoint for patient to view their case
 * No auth required — secured by UUID share token.
 */

function getServiceSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ shareToken: string }> }
) {
  const { shareToken } = await params
  const supabase = getServiceSupabase()

  // Find case by share token
  const { data: caseData, error } = await supabase
    .from('clinical_cases')
    .select(`
      id, case_number, patient_name, chief_complaint, status,
      case_files (id, file_name, file_url, file_type, mime_type),
      case_diagnosis (diagnosis_summary, severity, bone_quality, soft_tissue_status),
      case_treatment_plans (plan_summary, total_estimated_cost, estimated_duration, items),
      assigned_doctor:user_profiles!clinical_cases_assigned_doctor_id_fkey (full_name, specialty)
    `)
    .eq('share_token', shareToken)
    .in('status', ['patient_review', 'completed'])
    .single()

  if (error || !caseData) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Mark as viewed
  if (!caseData.status || caseData.status !== 'completed') {
    await supabase
      .from('clinical_cases')
      .update({ patient_viewed_at: new Date().toISOString() })
      .eq('id', caseData.id)
  }

  const result = {
    case_number: caseData.case_number,
    patient_name: caseData.patient_name,
    chief_complaint: caseData.chief_complaint,
    status: caseData.status,
    files: caseData.case_files || [],
    diagnosis: Array.isArray(caseData.case_diagnosis)
      ? caseData.case_diagnosis[0] || null
      : caseData.case_diagnosis || null,
    treatment_plan: Array.isArray(caseData.case_treatment_plans)
      ? caseData.case_treatment_plans[0] || null
      : caseData.case_treatment_plans || null,
    assigned_doctor: caseData.assigned_doctor || null,
  }

  return NextResponse.json({ case: result })
}
