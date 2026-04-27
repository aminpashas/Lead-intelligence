import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { logHIPAAEvent } from '@/lib/ai/hipaa'
import { logContractEvent } from '@/lib/contracts/orchestrator'

export const runtime = 'nodejs'

/**
 * GET /api/contracts/patient/[shareToken]
 * Public — no auth. Secured by the random UUID share_token.
 * Returns sanitized contract for the patient signing page.
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

  const { data: contract, error } = await supabase
    .from('patient_contracts')
    .select(`
      id, organization_id, clinical_case_id, status,
      generated_content, contract_amount, deposit_amount,
      financing_type, financing_monthly_payment,
      share_token_expires_at, signed_at, executed_pdf_storage_path
    `)
    .eq('share_token', shareToken)
    .maybeSingle()

  if (error || !contract) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (
    contract.share_token_expires_at &&
    new Date(contract.share_token_expires_at).getTime() < Date.now() &&
    !['signed', 'executed'].includes(contract.status)
  ) {
    return NextResponse.json({ error: 'Link expired', status: 'expired' }, { status: 410 })
  }

  // First view: advance status and log
  if (contract.status === 'sent') {
    await supabase
      .from('patient_contracts')
      .update({ status: 'viewed', first_viewed_at: new Date().toISOString() })
      .eq('id', contract.id)
    await logContractEvent(supabase, {
      organization_id: contract.organization_id,
      contract_id: contract.id,
      event_type: 'viewed',
      actor_type: 'patient',
    })
    await logHIPAAEvent(supabase, {
      organization_id: contract.organization_id,
      event_type: 'contract_viewed_by_patient',
      severity: 'info',
      actor_type: 'system',
      resource_type: 'patient_contract',
      resource_id: contract.id,
      description: 'Patient opened contract portal',
    })
  }

  // Org display info
  const { data: orgRow } = await supabase
    .from('organizations')
    .select('name, logo_url, phone, email')
    .eq('id', contract.organization_id)
    .single()

  const { data: caseRow } = await supabase
    .from('clinical_cases')
    .select('case_number, patient_name')
    .eq('id', contract.clinical_case_id)
    .single()

  // For executed contracts, generate a short-lived signed URL for download
  let downloadUrl: string | null = null
  if (contract.status === 'executed' && contract.executed_pdf_storage_path) {
    const { data } = await supabase.storage
      .from('case-files')
      .createSignedUrl(contract.executed_pdf_storage_path, 60 * 60) // 1 hour
    downloadUrl = data?.signedUrl ?? null
  }

  return NextResponse.json({
    contract: {
      id: contract.id,
      status: contract.status,
      generated_content: contract.generated_content,
      contract_amount: contract.contract_amount,
      deposit_amount: contract.deposit_amount,
      financing_type: contract.financing_type,
      financing_monthly_payment: contract.financing_monthly_payment,
      signed_at: contract.signed_at,
      share_token_expires_at: contract.share_token_expires_at,
    },
    organization: orgRow
      ? { name: orgRow.name, logo_url: orgRow.logo_url, phone: orgRow.phone, email: orgRow.email }
      : null,
    case: caseRow ? { case_number: caseRow.case_number, patient_first_name: (caseRow.patient_name ?? '').split(' ')[0] } : null,
    download_url: downloadUrl,
  })
}
