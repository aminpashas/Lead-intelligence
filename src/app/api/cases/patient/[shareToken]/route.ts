import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { auditPHIRead } from '@/lib/hipaa-audit'

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
      id, organization_id, case_number, patient_name, chief_complaint, status, share_token_expires_at,
      case_files (id, file_name, file_url, file_type, mime_type),
      case_diagnosis (diagnosis_summary, severity, bone_quality, soft_tissue_status),
      case_treatment_plans (plan_summary, total_estimated_cost, estimated_duration, items),
      assigned_doctor:user_profiles!clinical_cases_assigned_doctor_id_fkey (full_name, specialty)
    `)
    .eq('share_token', shareToken)
    .in('status', ['patient_review', 'accepted', 'closing', 'surgery_scheduled', 'ready_for_surgery', 'completed'])
    .single()

  if (error || !caseData) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Reject expired share links (PHI must not stay reachable forever via a leaked URL).
  if (caseData.share_token_expires_at && new Date(caseData.share_token_expires_at) < new Date()) {
    return NextResponse.json({ error: 'This link has expired' }, { status: 410 })
  }

  // HIPAA §164.312(b): record every PHI access through the patient portal.
  await auditPHIRead(
    { supabase, organizationId: caseData.organization_id, actorType: 'system', actorId: `patient_share:${shareToken.slice(0, 8)}…` },
    'clinical_case',
    caseData.id,
    'Patient viewed clinical case via share link',
    ['name', 'diagnosis', 'dental_specific'],
  )

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
