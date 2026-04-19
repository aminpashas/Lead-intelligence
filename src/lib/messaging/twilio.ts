import twilio from 'twilio'
import type { SupabaseClient } from '@supabase/supabase-js'
import { assertConsent, logConsentViolation, type ConsentDenyReason } from '@/lib/consent/gate'

function getClient() {
  return twilio(
    process.env.TWILIO_ACCOUNT_SID!,
    process.env.TWILIO_AUTH_TOKEN!
  )
}

/**
 * Low-level SMS send. Bypasses the consent gate.
 * Only use for system-internal sends (verification codes, staff alerts) where there is no lead.
 * For any lead-facing message, use sendSMSToLead() so consent is enforced.
 */
export async function sendSMS(to: string, body: string): Promise<{ sid: string; status: string }> {
  const message = await getClient().messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER!,
    to,
  })

  return {
    sid: message.sid,
    status: message.status,
  }
}

export type SendSMSToLeadResult =
  | { sent: true; sid: string; status: string }
  | { sent: false; reason: ConsentDenyReason }

/**
 * SMS send with TCPA consent enforcement (HARD GATE per brief Section 2.2).
 * If the lead has not granted SMS consent or has opted out, the send is refused
 * and a `consent_violation_prevented` row is written to the events table.
 *
 * Pass the resolved E.164 phone explicitly — this function does not look it up
 * (it's typically already decrypted in the caller's context).
 */
export async function sendSMSToLead(params: {
  supabase: SupabaseClient
  leadId: string
  to: string
  body: string
  caller?: string
}): Promise<SendSMSToLeadResult> {
  const decision = await assertConsent(params.supabase, params.leadId, 'sms')
  if (!decision.allowed) {
    await logConsentViolation(params.supabase, {
      organizationId: decision.lead?.organization_id ?? '',
      leadId: params.leadId,
      channel: 'sms',
      reason: decision.reason,
      bodyPreview: params.body,
      caller: params.caller,
    })
    return { sent: false, reason: decision.reason }
  }

  const result = await sendSMS(params.to, params.body)
  return { sent: true, sid: result.sid, status: result.status }
}

export function validateTwilioWebhook(
  signature: string,
  url: string,
  params: Record<string, string>
): boolean {
  return twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN!,
    signature,
    url,
    params
  )
}
