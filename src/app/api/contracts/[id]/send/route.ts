import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/permissions'
import { sendEmail } from '@/lib/messaging/resend'
import { renderEmail } from '@/emails/render'
import { ContractReady } from '@/emails/ContractReady'
import React from 'react'
import { logContractEvent } from '@/lib/contracts/orchestrator'
import { logHIPAAEvent } from '@/lib/ai/hipaa'

export const runtime = 'nodejs'

/**
 * POST /api/contracts/[id]/send
 * Sends the contract portal link to the patient via Resend.
 * Also handles re-send when status is already 'sent' (mints a new share_token).
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
    .select(`
      id, status, organization_id, clinical_case_id, share_token
    `)
    .eq('id', id)
    .eq('organization_id', profile.organization_id)
    .maybeSingle()
  if (!contract) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (!['approved', 'sent', 'viewed'].includes(contract.status)) {
    return NextResponse.json(
      { error: `Cannot send contract in status ${contract.status}` },
      { status: 409 }
    )
  }

  const { data: caseRow } = await supabase
    .from('clinical_cases')
    .select('patient_name, patient_email')
    .eq('id', contract.clinical_case_id)
    .single()
  if (!caseRow?.patient_email) {
    return NextResponse.json({ error: 'Patient has no email on file' }, { status: 422 })
  }

  const { data: orgRow } = await supabase
    .from('organizations')
    .select('name, settings')
    .eq('id', contract.organization_id)
    .single()
  const orgName = orgRow?.name ?? 'Your Practice'
  const settings = (orgRow?.settings ?? {}) as { contracts?: { share_token_expiry_days?: number } }
  const expiryDays = settings.contracts?.share_token_expiry_days ?? 30
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000)

  // If re-sending, rotate the share_token
  let shareToken = contract.share_token
  if (contract.status === 'sent' || contract.status === 'viewed') {
    const { data: rotated } = await supabase
      .from('patient_contracts')
      .update({ share_token: crypto.randomUUID() })
      .eq('id', id)
      .select('share_token')
      .single()
    if (rotated) shareToken = rotated.share_token
  }

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? ''
  const portalUrl = `${base}/contract/${shareToken}`
  const firstName = (caseRow.patient_name ?? '').split(' ')[0] || 'there'

  let emailId: string | null = null
  try {
    const { html, text } = await renderEmail(
      React.createElement(ContractReady, {
        patientFirstName: firstName,
        orgName,
        portalUrl,
        expiresAt: expiresAt.toISOString().slice(0, 10),
      })
    )
    const sendResult = await sendEmail({
      to: caseRow.patient_email,
      subject: `Your treatment agreement from ${orgName} — please review & sign`,
      html,
      text,
    })
    emailId = sendResult.id
  } catch (err) {
    console.error('[contracts/send] email send failed', err)
    return NextResponse.json({ error: 'Email send failed' }, { status: 502 })
  }

  const { data: updated, error: updErr } = await supabase
    .from('patient_contracts')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      sent_via: 'email',
      share_token_expires_at: expiresAt.toISOString(),
    })
    .eq('id', id)
    .select('id, status, share_token, share_token_expires_at, sent_at')
    .single()
  if (updErr || !updated) {
    return NextResponse.json({ error: updErr?.message ?? 'update failed' }, { status: 500 })
  }

  await logContractEvent(supabase, {
    organization_id: contract.organization_id,
    contract_id: contract.id,
    event_type: 'sent',
    actor_type: 'user',
    actor_id: user.id,
    payload: { email_id: emailId, portal_url: portalUrl, expires_at: expiresAt.toISOString() },
  })
  await logHIPAAEvent(supabase, {
    organization_id: contract.organization_id,
    event_type: 'contract_sent',
    severity: 'info',
    actor_type: 'user',
    actor_id: user.id,
    resource_type: 'patient_contract',
    resource_id: contract.id,
    description: 'Contract portal link sent to patient',
    metadata: { email_id: emailId },
  })

  return NextResponse.json({ contract: updated, portal_url: portalUrl })
}
