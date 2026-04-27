/**
 * Post-sign worker:
 *   1. Render the final PDF via @react-pdf/renderer.
 *   2. Compute SHA-256 of the bytes.
 *   3. Upload to Supabase Storage (case-files bucket).
 *   4. Update patient_contracts → status='executed' + storage path + hash.
 *   5. Insert a case_files row linking the PDF to the clinical case.
 *   6. Advance treatment_closings.current_step → 'contract_signed'.
 *   7. Send the patient a copy via Resend (with a signed URL).
 *   8. Audit log + contract_events.
 *
 * Runs server-side, Node runtime only (PDF + signed URLs).
 */

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import React from 'react'
import { pdf } from '@react-pdf/renderer'
import type { PatientContract } from '@/types/database'
import { ContractDocument } from './pdf/ContractDocument'
import { sendEmail } from '@/lib/messaging/resend'
import { renderEmail } from '@/emails/render'
import { ContractExecuted } from '@/emails/ContractExecuted'
import { logHIPAAEvent } from '@/lib/ai/hipaa'
import { logContractEvent } from './orchestrator'

function serviceSupabase(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export type ExecuteInput = {
  supabase?: SupabaseClient
  contractId: string
}

/**
 * Render an unsigned draft PDF at approval time and upload to storage.
 * Used by the approve endpoint so staff can preview (and patient can see
 * via their portal) the final document before signing.
 */
export async function renderDraftContractPdf(
  supabase: SupabaseClient,
  contractId: string
): Promise<{ ok: true; storage_path: string } | { ok: false; error: string }> {
  const { data: contract, error } = await supabase
    .from('patient_contracts')
    .select(`
      id, organization_id, clinical_case_id,
      generated_content, contract_amount, deposit_amount, financing_type,
      financing_monthly_payment, template_version, template_snapshot
    `)
    .eq('id', contractId)
    .single()
  if (error || !contract) return { ok: false, error: error?.message ?? 'Not found' }

  const { data: caseRow } = await supabase
    .from('clinical_cases')
    .select('case_number, patient_name')
    .eq('id', contract.clinical_case_id)
    .single()

  const { data: orgRow } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', contract.organization_id)
    .single()

  const element = React.createElement(ContractDocument, {
    contract: {
      ...contract,
      signed_at: null,
      signer_name: null,
      signer_ip: null,
      signer_user_agent: null,
      signature_data_url: null,
      consents_agreed: [],
      patient_name: caseRow?.patient_name ?? 'Patient',
      case_number: caseRow?.case_number ?? '',
      organization_name: orgRow?.name ?? 'Your Practice',
      effective_date: new Date().toISOString().slice(0, 10),
    },
  })

  let bytes: Buffer
  try {
    bytes = await bufferFromPdf(element)
  } catch (err) {
    console.error('[contracts/pdf-execute] draft PDF render failed', err)
    return { ok: false, error: 'PDF render failed' }
  }

  const storagePath = `${contract.organization_id}/${contract.clinical_case_id}/contracts/${contract.id}/draft.pdf`
  const { error: uploadErr } = await supabase.storage
    .from('case-files')
    .upload(storagePath, bytes, { contentType: 'application/pdf', upsert: true })
  if (uploadErr) return { ok: false, error: uploadErr.message }

  await supabase
    .from('patient_contracts')
    .update({ draft_pdf_storage_path: storagePath })
    .eq('id', contractId)

  return { ok: true, storage_path: storagePath }
}

export type ExecuteResult =
  | { ok: true; storage_path: string; sha256: string }
  | { ok: false; error: string }

async function bufferFromPdf(element: React.ReactElement): Promise<Buffer> {
  // @react-pdf/renderer's pdf().toBuffer() returns a NodeJS.ReadableStream in Node.
  // Cast through unknown because the @react-pdf types are specific to their Document.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = (await (pdf as any)(element).toBuffer()) as NodeJS.ReadableStream
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

export async function executeSignedContract(input: ExecuteInput): Promise<ExecuteResult> {
  const supabase = input.supabase ?? serviceSupabase()
  const contractId = input.contractId

  const { data: contract, error: contractErr } = await supabase
    .from('patient_contracts')
    .select(`
      id, organization_id, clinical_case_id, treatment_closing_id,
      generated_content, contract_amount, deposit_amount, financing_type,
      financing_monthly_payment, signed_at, signer_name, signer_ip,
      signer_user_agent, signature_data_url, consents_agreed,
      template_version, template_snapshot, status
    `)
    .eq('id', contractId)
    .single()

  if (contractErr || !contract) {
    return { ok: false, error: contractErr?.message ?? 'Contract not found' }
  }
  if (contract.status !== 'signed') {
    return { ok: false, error: `Contract is not in signed state (status=${contract.status})` }
  }

  const { data: caseRow } = await supabase
    .from('clinical_cases')
    .select('id, case_number, patient_name, patient_email')
    .eq('id', contract.clinical_case_id)
    .single()

  const { data: orgRow } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', contract.organization_id)
    .single()

  const orgName = orgRow?.name ?? 'Your Practice'
  const caseNumber = caseRow?.case_number ?? ''
  const patientName = caseRow?.patient_name ?? contract.signer_name ?? 'Patient'

  // 1. Render PDF
  const element = React.createElement(ContractDocument, {
    contract: {
      ...contract,
      patient_name: patientName,
      case_number: caseNumber,
      organization_name: orgName,
      effective_date: contract.signed_at ? new Date(contract.signed_at).toISOString().slice(0, 10) : '',
    },
  })

  let pdfBytes: Buffer
  try {
    pdfBytes = await bufferFromPdf(element)
  } catch (err) {
    console.error('[contracts/pdf-execute] PDF render failed', err)
    return { ok: false, error: 'PDF render failed' }
  }

  // 2. Hash
  const sha256 = createHash('sha256').update(pdfBytes).digest('hex')

  // 3. Upload
  const storagePath = `${contract.organization_id}/${contract.clinical_case_id}/contracts/${contract.id}/executed-${Date.now()}.pdf`
  const { error: uploadErr } = await supabase.storage
    .from('case-files')
    .upload(storagePath, pdfBytes, { contentType: 'application/pdf', upsert: false })

  if (uploadErr) {
    console.error('[contracts/pdf-execute] upload failed', uploadErr)
    return { ok: false, error: `Storage upload failed: ${uploadErr.message}` }
  }

  const { data: urlData } = supabase.storage.from('case-files').getPublicUrl(storagePath)

  // 4. Update patient_contracts → 'executed'
  const { error: updateErr } = await supabase
    .from('patient_contracts')
    .update({
      status: 'executed',
      executed_pdf_storage_path: storagePath,
      executed_pdf_sha256: sha256,
    })
    .eq('id', contract.id)

  if (updateErr) {
    console.error('[contracts/pdf-execute] patient_contracts update failed', updateErr)
    return { ok: false, error: `DB update failed: ${updateErr.message}` }
  }

  // 5. Link PDF to case_files for the case timeline
  await supabase.from('case_files').insert({
    case_id: contract.clinical_case_id,
    organization_id: contract.organization_id,
    file_name: `signed-contract-v${contract.template_version}.pdf`,
    file_url: urlData?.publicUrl ?? storagePath,
    file_size: pdfBytes.length,
    mime_type: 'application/pdf',
    file_type: 'other',
    description: `Signed Treatment Services Agreement v${contract.template_version}`,
    uploaded_by: null,
  })

  // 6. Advance treatment_closings
  if (contract.treatment_closing_id) {
    const { data: closing } = await supabase
      .from('treatment_closings')
      .select('current_step, steps_completed, contract_signed_at')
      .eq('id', contract.treatment_closing_id)
      .single()

    if (closing && closing.current_step === 'treatment_plan_presented' && !closing.contract_signed_at) {
      const completed = Array.isArray(closing.steps_completed) ? closing.steps_completed : []
      if (!completed.includes('contract_signed')) completed.push('contract_signed')
      await supabase
        .from('treatment_closings')
        .update({
          current_step: 'contract_signed',
          contract_signed_at: contract.signed_at,
          steps_completed: completed,
        })
        .eq('id', contract.treatment_closing_id)
    }
  }

  // 7. Email the patient their signed copy with a signed URL (7-day expiry)
  if (caseRow?.patient_email) {
    try {
      const { data: signedUrl } = await supabase.storage
        .from('case-files')
        .createSignedUrl(storagePath, 60 * 60 * 24 * 7)
      const link = signedUrl?.signedUrl ?? urlData?.publicUrl ?? ''
      const { html, text } = await renderEmail(
        React.createElement(ContractExecuted, {
          patientFirstName: patientName.split(' ')[0] || patientName,
          orgName,
          downloadUrl: link,
        })
      )
      await sendEmail({
        to: caseRow.patient_email,
        subject: `Your signed treatment agreement with ${orgName}`,
        html,
        text,
      })
    } catch (err) {
      console.error('[contracts/pdf-execute] email send failed', err)
    }
  }

  // 8. Audit
  await logContractEvent(supabase, {
    organization_id: contract.organization_id,
    contract_id: contract.id,
    event_type: 'executed',
    actor_type: 'system',
    payload: { sha256, storage_path: storagePath },
  })

  await logHIPAAEvent(supabase, {
    organization_id: contract.organization_id,
    event_type: 'contract_executed',
    severity: 'info',
    actor_type: 'system',
    resource_type: 'patient_contract',
    resource_id: contract.id,
    description: 'Executed contract PDF generated and stored.',
    metadata: { sha256, storage_path: storagePath },
  })

  return { ok: true, storage_path: storagePath, sha256 }
}
