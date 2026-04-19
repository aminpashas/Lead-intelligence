/**
 * Consent Gate — TCPA / CAN-SPAM hard enforcement
 *
 * Every automated outbound message MUST pass through the gate before send.
 * The brief (Section 2.2) calls this non-negotiable: if consent is missing or revoked,
 * the send fails silently and writes a `consent_violation_prevented` row to `events`.
 *
 * State of record lives on the `leads` row:
 *   sms_consent / sms_opt_out      → channel='sms'
 *   email_consent / email_opt_out  → channel='email'
 *   voice_consent / voice_opt_out  → channel='voice'
 *   do_not_call                    → blocks voice regardless of voice_consent
 *
 * Audit history lives in `consent_log` (auto-appended via DB trigger when consent fields change).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type ConsentChannel = 'sms' | 'email' | 'voice'

export type ConsentDecision =
  | { allowed: true; lead: ConsentLeadFields }
  | { allowed: false; reason: ConsentDenyReason; lead: ConsentLeadFields | null }

export type ConsentDenyReason =
  | 'lead_not_found'
  | 'no_consent'
  | 'opted_out'
  | 'do_not_call'
  | 'lookup_failed'

type ConsentLeadFields = {
  id: string
  organization_id: string
  sms_consent: boolean | null
  sms_opt_out: boolean | null
  email_consent: boolean | null
  email_opt_out: boolean | null
  voice_consent: boolean | null
  voice_opt_out: boolean | null
  do_not_call: boolean | null
}

const CONSENT_FIELDS = [
  'id',
  'organization_id',
  'sms_consent',
  'sms_opt_out',
  'email_consent',
  'email_opt_out',
  'voice_consent',
  'voice_opt_out',
  'do_not_call',
].join(',')

/**
 * Check whether the lead has consented to receive a message on this channel.
 * Does NOT log violations — that's the caller's job (so we can include the channel + body context).
 */
export async function assertConsent(
  supabase: SupabaseClient,
  leadId: string,
  channel: ConsentChannel
): Promise<ConsentDecision> {
  const { data: lead, error } = await supabase
    .from('leads')
    .select(CONSENT_FIELDS)
    .eq('id', leadId)
    .single<ConsentLeadFields>()

  if (error || !lead) {
    return { allowed: false, reason: lead ? 'lookup_failed' : 'lead_not_found', lead: null }
  }

  switch (channel) {
    case 'sms': {
      if (lead.sms_opt_out === true) return { allowed: false, reason: 'opted_out', lead }
      if (lead.sms_consent !== true) return { allowed: false, reason: 'no_consent', lead }
      return { allowed: true, lead }
    }
    case 'email': {
      if (lead.email_opt_out === true) return { allowed: false, reason: 'opted_out', lead }
      if (lead.email_consent !== true) return { allowed: false, reason: 'no_consent', lead }
      return { allowed: true, lead }
    }
    case 'voice': {
      // do_not_call overrides everything (federal DNC list, internal flag, etc.)
      if (lead.do_not_call === true) return { allowed: false, reason: 'do_not_call', lead }
      if (lead.voice_opt_out === true) return { allowed: false, reason: 'opted_out', lead }
      if (lead.voice_consent !== true) return { allowed: false, reason: 'no_consent', lead }
      return { allowed: true, lead }
    }
  }
}

/**
 * Log a blocked send to the events table for the compliance audit trail.
 * Best-effort; never throws (we don't want logging failures to mask the actual deny).
 */
export async function logConsentViolation(
  supabase: SupabaseClient,
  params: {
    organizationId: string
    leadId: string
    channel: ConsentChannel
    reason: ConsentDenyReason
    bodyPreview?: string  // first 100 chars of attempted message body, for forensics
    caller?: string       // e.g., 'sendSMSToLead', 'executor.send_sms'
  }
): Promise<void> {
  try {
    await supabase.from('events').insert({
      organization_id: params.organizationId,
      lead_id: params.leadId,
      event_type: 'consent_violation_prevented',
      payload: {
        channel: params.channel,
        reason: params.reason,
        caller: params.caller ?? null,
        body_preview: params.bodyPreview ? params.bodyPreview.slice(0, 100) : null,
      },
      capi_status: 'na',
      gads_status: 'na',
    })
  } catch {
    // Logging is best-effort. The deny is what matters.
  }
}
