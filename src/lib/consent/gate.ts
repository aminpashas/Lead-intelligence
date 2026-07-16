/**
 * Consent Gate — opt-out (DND) enforcement
 *
 * Every automated outbound message MUST pass through the gate before send.
 * Consent is ASSUMED for every lead: a message is allowed unless the lead has
 * explicitly opted out (picked Do-Not-Disturb) on that channel. When a send is
 * refused, the caller writes a `consent_violation_prevented` row to `events`.
 *
 * State of record lives on the `leads` row (only the opt-out flags gate a send):
 *   sms_opt_out      → blocks channel='sms'
 *   email_opt_out    → blocks channel='email'
 *   voice_opt_out    → blocks channel='voice'
 *   do_not_call      → blocks voice (federal DNC list / internal flag)
 *
 * The `*_consent` booleans are retained on the row for record-keeping and for the
 * re-permission campaign gates below, but they no longer block an outbound send —
 * only an explicit opt-out (or DNC for voice) does.
 *
 * Audit history lives in `consent_log` (auto-appended via DB trigger when consent fields change).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type ConsentChannel = 'sms' | 'email' | 'voice'

export type ConsentStatusValue = 'granted' | 'declined' | 'unknown'

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
  // Tri-state status (additive; the booleans above remain the gate's source of truth)
  sms_consent_status: ConsentStatusValue | null
  email_consent_status: ConsentStatusValue | null
  voice_consent_status: ConsentStatusValue | null
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
  'sms_consent_status',
  'email_consent_status',
  'voice_consent_status',
].join(',')

/**
 * Check whether the lead may be messaged on this channel. Consent is assumed:
 * the only thing that blocks a send is an explicit opt-out (DND) on the channel
 * — plus do_not_call for voice. A lead we never asked (consent unknown) passes.
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
      return { allowed: true, lead }
    }
    case 'email': {
      if (lead.email_opt_out === true) return { allowed: false, reason: 'opted_out', lead }
      return { allowed: true, lead }
    }
    case 'voice': {
      // do_not_call overrides everything (federal DNC list, internal flag, etc.)
      if (lead.do_not_call === true) return { allowed: false, reason: 'do_not_call', lead }
      if (lead.voice_opt_out === true) return { allowed: false, reason: 'opted_out', lead }
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

// ── Consent-capture eligibility (Phase 1.2) ─────────────────────────────
// A lead the gate BLOCKS is not necessarily off-limits: if we never asked
// (status 'unknown') we may still solicit consent on a permitted first touch.
// A 'declined' lead must never be solicited. This is the targeting predicate
// for the consent-capture flow / "needs consent" segment.

type ConsentEligibilityFields = {
  sms_consent_status?: ConsentStatusValue | null
  email_consent_status?: ConsentStatusValue | null
  voice_consent_status?: ConsentStatusValue | null
  sms_opt_out?: boolean | null
  email_opt_out?: boolean | null
  voice_opt_out?: boolean | null
  do_not_call?: boolean | null
}

/**
 * True when the lead has not granted and not declined this channel — i.e. we
 * never captured consent and may run the consent-capture flow. Hard opt-out /
 * DNC always disqualifies, even if status is somehow stale.
 */
export function isEligibleForConsentCapture(
  lead: ConsentEligibilityFields,
  channel: ConsentChannel
): boolean {
  switch (channel) {
    case 'sms':
      return lead.sms_consent_status === 'unknown' && lead.sms_opt_out !== true
    case 'email':
      return lead.email_consent_status === 'unknown' && lead.email_opt_out !== true
    case 'voice':
      return (
        lead.voice_consent_status === 'unknown' &&
        lead.voice_opt_out !== true &&
        lead.do_not_call !== true
      )
  }
}

// ── Campaign email gate (re-permission override) ────────────────────────
// A campaign flagged `allow_unconsented_email` may email leads we NEVER asked
// (status 'unknown') — the CAN-SPAM-lawful re-permission path. It never
// overrides a hard "no": email_opt_out and status 'declined' always refuse.
// (An analogous smsCampaignGate exists below — see the TCPA warning there.)

type EmailCampaignGateLead = {
  email_consent?: boolean | null
  email_opt_out?: boolean | null
  email_consent_status?: ConsentStatusValue | null
}

export type EmailCampaignGateResult =
  | { allowed: true; usedOverride: boolean }
  | { allowed: false; reason: 'opted_out' | 'declined' | 'no_consent' }

/**
 * Decide whether a campaign email may go to this lead. With
 * `allowUnconsented`, consent-unknown leads pass (usedOverride: true) so the
 * caller can audit-log the send; opted-out and declined leads never pass.
 */
export function emailCampaignGate(
  lead: EmailCampaignGateLead,
  opts: { allowUnconsented: boolean }
): EmailCampaignGateResult {
  if (lead.email_opt_out === true) return { allowed: false, reason: 'opted_out' }
  if (lead.email_consent === true) return { allowed: true, usedOverride: false }
  if (lead.email_consent_status === 'declined') return { allowed: false, reason: 'declined' }
  if (!opts.allowUnconsented) return { allowed: false, reason: 'no_consent' }
  return { allowed: true, usedOverride: true }
}

/**
 * Audit row for every email sent under the re-permission override, so
 * compliance can enumerate exactly which sends bypassed the consent boolean.
 * Best-effort like logConsentViolation.
 */
export async function logUnconsentedEmailSend(
  supabase: SupabaseClient,
  params: {
    organizationId: string
    leadId: string
    campaignId: string | null
    caller: string // e.g. 'campaign.executor', 'email.mass'
  }
): Promise<void> {
  try {
    await supabase.from('events').insert({
      organization_id: params.organizationId,
      lead_id: params.leadId,
      event_type: 'email_sent_unconsented_repermission',
      payload: {
        campaign_id: params.campaignId,
        caller: params.caller,
      },
      capi_status: 'na',
      gads_status: 'na',
    })
  } catch {
    // Logging is best-effort; the send outcome is already recorded in messages.
  }
}

// ── Campaign SMS gate (re-permission override) ──────────────────────────
// ⚠️ TCPA: unlike email/CAN-SPAM, texting a lead who never granted express
// consent has NO re-permission safe harbor and carries $500–$1,500 per-message
// statutory damages. This override exists ONLY because the org owner explicitly
// enabled manual bulk re-permission SMS; it is off by default and must be opted
// into per broadcast (`allow_unconsented`). It NEVER overrides a hard "no":
// sms_opt_out and status 'declined' always refuse. Every unconsented send is
// audit-logged via logUnconsentedSmsSend.

type SmsCampaignGateLead = {
  sms_consent?: boolean | null
  sms_opt_out?: boolean | null
  sms_consent_status?: ConsentStatusValue | null
}

export type SmsCampaignGateResult =
  | { allowed: true; usedOverride: boolean }
  | { allowed: false; reason: 'opted_out' | 'declined' | 'no_consent' }

/**
 * Decide whether a campaign SMS may go to this lead. With `allowUnconsented`,
 * consent-unknown leads pass (usedOverride: true) so the caller can audit-log
 * the send; opted-out and declined leads never pass. Mirrors emailCampaignGate.
 */
export function smsCampaignGate(
  lead: SmsCampaignGateLead,
  opts: { allowUnconsented: boolean }
): SmsCampaignGateResult {
  if (lead.sms_opt_out === true) return { allowed: false, reason: 'opted_out' }
  if (lead.sms_consent === true) return { allowed: true, usedOverride: false }
  if (lead.sms_consent_status === 'declined') return { allowed: false, reason: 'declined' }
  if (!opts.allowUnconsented) return { allowed: false, reason: 'no_consent' }
  return { allowed: true, usedOverride: true }
}

/**
 * Audit row for every SMS sent under the re-permission override, so compliance
 * can enumerate exactly which sends bypassed the consent boolean. Best-effort.
 */
export async function logUnconsentedSmsSend(
  supabase: SupabaseClient,
  params: {
    organizationId: string
    leadId: string
    campaignId: string | null
    caller: string // e.g. 'sms.mass'
  }
): Promise<void> {
  try {
    await supabase.from('events').insert({
      organization_id: params.organizationId,
      lead_id: params.leadId,
      event_type: 'sms_sent_unconsented_repermission',
      payload: {
        campaign_id: params.campaignId,
        caller: params.caller,
      },
      capi_status: 'na',
      gads_status: 'na',
    })
  } catch {
    // Logging is best-effort; the send outcome is already recorded in messages.
  }
}
