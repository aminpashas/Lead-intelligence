import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { fireAndForgetEnsureContract } from '@/lib/contracts/orchestrator'
import { createTreatmentClosing } from '@/lib/treatment/treatment-closing'

/**
 * POST /api/cases/patient/[shareToken]/accept — Patient acknowledges the treatment plan.
 * Moves the case into the closing pipeline (status 'accepted'), creates the
 * treatment closing record, and triggers AI contract draft generation.
 */

function getServiceSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ shareToken: string }> }
) {
  const { shareToken } = await params
  const supabase = getServiceSupabase()

  const { data: caseData, error } = await supabase
    .from('clinical_cases')
    .select('id, organization_id, lead_id, patient_accepted_at, status, share_token_expires_at')
    .eq('share_token', shareToken)
    .in('status', ['patient_review', 'accepted', 'completed'])
    .single()

  if (error || !caseData) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Mirror the GET route: a leaked/expired share link must not stay actionable.
  // Accepting flips the case to completed and triggers AI contract generation,
  // so an expired token must be rejected here too.
  if (caseData.share_token_expires_at && new Date(caseData.share_token_expires_at) < new Date()) {
    return NextResponse.json({ error: 'This link has expired' }, { status: 410 })
  }

  const firstAcceptance = !caseData.patient_accepted_at

  // Also mark treatment plan approved so downstream code sees a single source of truth
  await supabase
    .from('case_treatment_plans')
    .update({ approved_at: new Date().toISOString() })
    .eq('case_id', caseData.id)
    .is('approved_at', null)

  // Acceptance moves the case into the closing pipeline, not straight to completed.
  // Only bump forward from patient_review — re-accepts must not regress a case
  // that has already progressed through closing.
  await supabase
    .from('clinical_cases')
    .update({
      patient_accepted_at: new Date().toISOString(),
      ...(caseData.status === 'patient_review' ? { status: 'accepted' } : {}),
    })
    .eq('id', caseData.id)

  if (firstAcceptance) {
    const { data: plan } = await supabase
      .from('case_treatment_plans')
      .select('total_estimated_cost')
      .eq('case_id', caseData.id)
      .single()

    await createTreatmentClosing(supabase, {
      organizationId: caseData.organization_id,
      leadId: caseData.lead_id,
      clinicalCaseId: caseData.id,
      contractAmount: plan?.total_estimated_cost ?? null,
    })

    fireAndForgetEnsureContract({
      organizationId: caseData.organization_id,
      caseId: caseData.id,
      actorType: 'system',
    })
  }

  return NextResponse.json({ success: true })
}
