import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { fireAndForgetEnsureContract } from '@/lib/contracts/orchestrator'

/**
 * POST /api/cases/patient/[shareToken]/accept — Patient acknowledges the treatment plan.
 * Triggers AI contract draft generation (fire-and-forget).
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
    .select('id, organization_id, patient_accepted_at, status, share_token_expires_at')
    .eq('share_token', shareToken)
    .in('status', ['patient_review', 'completed'])
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

  await supabase
    .from('clinical_cases')
    .update({
      patient_accepted_at: new Date().toISOString(),
      status: 'completed',
    })
    .eq('id', caseData.id)

  if (firstAcceptance) {
    fireAndForgetEnsureContract({
      organizationId: caseData.organization_id,
      caseId: caseData.id,
      actorType: 'system',
    })
  }

  return NextResponse.json({ success: true })
}
