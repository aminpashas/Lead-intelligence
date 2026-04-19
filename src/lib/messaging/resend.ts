import { Resend } from 'resend'
import type { SupabaseClient } from '@supabase/supabase-js'
import { assertConsent, logConsentViolation, type ConsentDenyReason } from '@/lib/consent/gate'

function getResend() {
  return new Resend(process.env.RESEND_API_KEY!)
}

/**
 * Low-level email send. Bypasses the consent gate.
 * Only use for transactional/system sends (password resets, billing receipts, staff notifications).
 * For any lead-facing marketing/nurture email, use sendEmailToLead() so consent is enforced.
 */
export async function sendEmail(params: {
  to: string
  subject: string
  html: string
  text?: string
  from?: string
  replyTo?: string
}): Promise<{ id: string }> {
  const { data, error } = await getResend().emails.send({
    from: params.from || process.env.RESEND_FROM_EMAIL!,
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
    replyTo: params.replyTo,
  })

  if (error) {
    throw new Error(`Failed to send email: ${error.message}`)
  }

  return { id: data!.id }
}

export type SendEmailToLeadResult =
  | { sent: true; id: string }
  | { sent: false; reason: ConsentDenyReason }

/**
 * Email send with CAN-SPAM consent enforcement (HARD GATE per brief Section 2.2).
 * If the lead has not granted email consent or has unsubscribed, the send is refused
 * and a `consent_violation_prevented` row is written to the events table.
 */
export async function sendEmailToLead(params: {
  supabase: SupabaseClient
  leadId: string
  to: string
  subject: string
  html: string
  text?: string
  from?: string
  replyTo?: string
  caller?: string
}): Promise<SendEmailToLeadResult> {
  const decision = await assertConsent(params.supabase, params.leadId, 'email')
  if (!decision.allowed) {
    await logConsentViolation(params.supabase, {
      organizationId: decision.lead?.organization_id ?? '',
      leadId: params.leadId,
      channel: 'email',
      reason: decision.reason,
      bodyPreview: params.subject,
      caller: params.caller,
    })
    return { sent: false, reason: decision.reason }
  }

  const result = await sendEmail({
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
    from: params.from,
    replyTo: params.replyTo,
  })
  return { sent: true, id: result.id }
}

export async function sendBatchEmails(
  emails: Array<{
    to: string
    subject: string
    html: string
    text?: string
  }>
): Promise<{ ids: string[] }> {
  const { data, error } = await getResend().batch.send(
    emails.map((e) => ({
      from: process.env.RESEND_FROM_EMAIL!,
      to: e.to,
      subject: e.subject,
      html: e.html,
      text: e.text,
    }))
  )

  if (error) {
    throw new Error(`Failed to send batch emails: ${error.message}`)
  }

  return { ids: data!.data.map((d) => d.id) }
}
