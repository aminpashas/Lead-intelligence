import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/permissions'
import { renderDraftContractPdf } from '@/lib/contracts/pdf-execute'
import { logContractEvent } from '@/lib/contracts/orchestrator'
import { logHIPAAEvent } from '@/lib/ai/hipaa'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * POST /api/contracts/[id]/approve
 * Role-gated approver action. Renders the draft PDF and flips status to 'approved'.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()
  if (!profile || !hasPermission(profile.role, 'contracts:approve')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id } = await params
  const { data: contract } = await supabase
    .from('patient_contracts')
    .select('id, status, organization_id')
    .eq('id', id)
    .eq('organization_id', profile.organization_id)
    .maybeSingle()
  if (!contract) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (!['pending_review', 'changes_requested'].includes(contract.status)) {
    return NextResponse.json(
      { error: `Cannot approve contract in status ${contract.status}` },
      { status: 409 }
    )
  }

  const pdfResult = await renderDraftContractPdf(supabase, contract.id)
  if (!pdfResult.ok) {
    return NextResponse.json({ error: `PDF render failed: ${pdfResult.error}` }, { status: 500 })
  }

  const { error: updErr, data: updated } = await supabase
    .from('patient_contracts')
    .update({
      status: 'approved',
      approved_at: new Date().toISOString(),
      reviewer_id: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('id, status, draft_pdf_storage_path')
    .single()
  if (updErr || !updated) {
    return NextResponse.json({ error: updErr?.message ?? 'update failed' }, { status: 500 })
  }

  await logContractEvent(supabase, {
    organization_id: contract.organization_id,
    contract_id: contract.id,
    event_type: 'approved',
    actor_type: 'user',
    actor_id: user.id,
    payload: { draft_pdf_storage_path: pdfResult.storage_path },
  })
  await logHIPAAEvent(supabase, {
    organization_id: contract.organization_id,
    event_type: 'contract_approved',
    severity: 'info',
    actor_type: 'user',
    actor_id: user.id,
    resource_type: 'patient_contract',
    resource_id: contract.id,
    description: 'Contract approved by staff; draft PDF rendered and stored',
  })

  return NextResponse.json({ contract: updated })
}
