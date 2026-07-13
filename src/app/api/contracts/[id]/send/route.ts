import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { hasPermission } from '@/lib/auth/permissions'
import { sendEmail, transactionalFrom } from '@/lib/messaging/resend'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { renderEmail } from '@/emails/render'
import { ContractReady } from '@/emails/ContractReady'
import React from 'react'
import { logContractEvent } from '@/lib/contracts/orchestrator'
import { logHIPAAEvent } from '@/lib/ai/hipaa'

export const runtime = 'nodejs'

type Channel = 'email' | 'sms'

/**
 * Human-readable reason for an SMS that the consent/compliance chain refused,
 * so staff see *why* the text didn't go out (not just "failed").
 */
function smsFailureMessage(reason: string): string {
  switch (reason) {
    case 'no_consent':
    case 'opted_out':
      return 'Patient has not consented to SMS (or opted out)'
    case 'quiet_hours':
      return 'Blocked by TCPA quiet hours (8am–9pm local) — try again later'
    case 'us_sms_disabled':
      return 'US SMS is not enabled for this practice yet'
    case 'compliance_blocked':
    case 'compliance_review_required':
      return 'Message blocked by the compliance filter'
    default:
      return `SMS not sent (${reason})`
  }
}

/**
 * POST /api/contracts/[id]/send
 * Sends the contract portal link to the patient via email and/or SMS.
 *
 * Body: { channels?: ('email' | 'sms')[] } — defaults to ['email'] for
 * backward-compatibility with the approve-and-send flow. SMS is only permitted
 * when the case is linked to a lead (so consent can be enforced) and a phone is
 * on file. Also handles re-send when status is already 'sent'/'viewed' (mints a
 * new share_token). Delivery is best-effort per channel: if at least one channel
 * succeeds the contract advances to 'sent'; the response reports every outcome.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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

  // Requested channels — default to email only (approve flow sends no body).
  const body = (await request.json().catch(() => ({}))) as { channels?: unknown }
  const requested: Channel[] = Array.isArray(body.channels)
    ? (body.channels.filter((c) => c === 'email' || c === 'sms') as Channel[])
    : ['email']
  const wantEmail = requested.includes('email')
  const wantSms = requested.includes('sms')
  if (!wantEmail && !wantSms) {
    return NextResponse.json({ error: 'No valid channel selected' }, { status: 400 })
  }

  const { id } = await params
  const { data: contract } = await supabase
    .from('patient_contracts')
    .select(`
      id, status, organization_id, clinical_case_id, share_token
    `)
    .eq('id', id)
    .eq('organization_id', orgId)
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
    .select('patient_name, patient_email, patient_phone, lead_id')
    .eq('id', contract.clinical_case_id)
    .single()

  // Validate contactability up front for each requested channel.
  if (wantEmail && !caseRow?.patient_email) {
    return NextResponse.json({ error: 'Patient has no email on file' }, { status: 422 })
  }
  if (wantSms && !caseRow?.patient_phone) {
    return NextResponse.json({ error: 'Patient has no phone on file' }, { status: 422 })
  }
  if (wantSms && !caseRow?.lead_id) {
    // No linked lead => no consent record to check => refuse rather than send
    // an unconsented text. (Never fall back to the consent-bypassing sendSMS.)
    return NextResponse.json(
      { error: 'Cannot verify SMS consent — this case is not linked to a lead. Use email.' },
      { status: 422 }
    )
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

  // If re-sending, rotate the share_token so the previous link stops working.
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
  const firstName = (caseRow?.patient_name ?? '').split(' ')[0] || 'there'
  const expiryDate = expiresAt.toISOString().slice(0, 10)

  const sent: Channel[] = []
  const errors: Partial<Record<Channel, string>> = {}
  let emailId: string | null = null
  let smsSid: string | null = null

  // ── Email ─────────────────────────────────────────────────────
  if (wantEmail && caseRow?.patient_email) {
    try {
      const { html, text } = await renderEmail(
        React.createElement(ContractReady, {
          patientFirstName: firstName,
          orgName,
          portalUrl,
          expiresAt: expiryDate,
        })
      )
      const sendResult = await sendEmail({
        to: caseRow.patient_email,
        from: transactionalFrom(),
        subject: `Your treatment agreement from ${orgName} — please review & sign`,
        html,
        text,
      })
      emailId = sendResult.id
      sent.push('email')
    } catch (err) {
      console.error('[contracts/send] email send failed', err)
      errors.email = 'Email send failed'
    }
  }

  // ── SMS (consent-gated via sendSMSToLead) ─────────────────────
  if (wantSms && caseRow?.patient_phone && caseRow.lead_id) {
    const smsResult = await sendSMSToLead({
      supabase,
      leadId: caseRow.lead_id,
      to: caseRow.patient_phone,
      body: `${orgName}: your treatment agreement is ready to review & sign: ${portalUrl} — expires ${expiryDate}. Reply STOP to opt out.`,
      caller: 'contract-send',
    })
    if (smsResult.sent) {
      smsSid = smsResult.sid
      sent.push('sms')
    } else {
      errors.sms = smsFailureMessage(smsResult.reason)
    }
  }

  // Nothing went out on any requested channel — leave status untouched.
  if (sent.length === 0) {
    return NextResponse.json(
      { error: 'Delivery failed on all channels', errors },
      { status: 502 }
    )
  }

  const sentVia = sent.includes('email') && sent.includes('sms')
    ? 'email+sms'
    : sent[0] // 'email' | 'sms'

  const { data: updated, error: updErr } = await supabase
    .from('patient_contracts')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      sent_via: sentVia,
      share_token_expires_at: expiresAt.toISOString(),
    })
    .eq('id', id)
    .select('id, status, share_token, share_token_expires_at, sent_at, sent_via')
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
    payload: {
      channels: sent,
      email_id: emailId,
      sms_sid: smsSid,
      errors,
      portal_url: portalUrl,
      expires_at: expiresAt.toISOString(),
    },
  })
  await logHIPAAEvent(supabase, {
    organization_id: contract.organization_id,
    event_type: 'contract_sent',
    severity: 'info',
    actor_type: 'user',
    actor_id: user.id,
    resource_type: 'patient_contract',
    resource_id: contract.id,
    description: `Contract portal link sent to patient via ${sent.join('+')}`,
    metadata: { email_id: emailId, sms_sid: smsSid, channels: sent },
  })

  return NextResponse.json({
    contract: updated,
    portal_url: portalUrl,
    sent_via: sentVia,
    sent,
    errors,
  })
}
