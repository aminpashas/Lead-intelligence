/**
 * Resolve consent + suppression for one imported lead row.
 *
 * Safety rule (TCPA/CAN-SPAM): an opt-out is DOMINANT. A per-channel opt-out —
 * or an all-channel `do_not_contact` (e.g. mapped from a GHL DND export) —
 * forces that channel's consent OFF regardless of any consent value in the same
 * row, and sets the `*_opt_out` columns the send-gates actually check
 * (campaign executor + speed-to-lead gate on `sms_opt_out`/`email_opt_out`).
 *
 * Pure — no I/O — so the precedence is unit-testable without mocks.
 */

export type ImportConsentRow = {
  sms_consent?: boolean
  email_consent?: boolean
  voice_consent?: boolean
  sms_consent_at?: string
  email_consent_at?: string
  voice_consent_at?: string
  sms_consent_source?: string
  email_consent_source?: string
  voice_consent_source?: string
  do_not_call?: boolean
  sms_opt_out?: boolean
  email_opt_out?: boolean
  do_not_contact?: boolean
}

export type ImportConsentDefaults = {
  sms: boolean
  email: boolean
  voice: boolean
  source: string
  attested_at: string
}

export type ResolvedConsentFields = {
  sms_consent: boolean
  email_consent: boolean
  voice_consent: boolean
  sms_consent_at: string | null
  email_consent_at: string | null
  voice_consent_at: string | null
  sms_consent_source: string | null
  email_consent_source: string | null
  voice_consent_source: string | null
  sms_opt_out: boolean
  email_opt_out: boolean
  do_not_call: boolean
}

export function resolveImportConsent(
  row: ImportConsentRow,
  consent: ImportConsentDefaults,
): ResolvedConsentFields {
  const dnc = row.do_not_contact === true
  const smsOptOut = dnc || row.sms_opt_out === true
  const emailOptOut = dnc || row.email_opt_out === true

  // Opt-out wins over any consent value in the same row.
  const smsConsent = smsOptOut ? false : (row.sms_consent ?? consent.sms)
  const emailConsent = emailOptOut ? false : (row.email_consent ?? consent.email)
  const voiceConsent = dnc ? false : (row.voice_consent ?? consent.voice)

  return {
    sms_consent: smsConsent,
    email_consent: emailConsent,
    voice_consent: voiceConsent,
    sms_consent_at: smsConsent ? (row.sms_consent_at || consent.attested_at) : null,
    email_consent_at: emailConsent ? (row.email_consent_at || consent.attested_at) : null,
    voice_consent_at: voiceConsent ? (row.voice_consent_at || consent.attested_at) : null,
    sms_consent_source: smsConsent ? (row.sms_consent_source || consent.source) : null,
    email_consent_source: emailConsent ? (row.email_consent_source || consent.source) : null,
    voice_consent_source: voiceConsent ? (row.voice_consent_source || consent.source) : null,
    sms_opt_out: smsOptOut,
    email_opt_out: emailOptOut,
    // do_not_call (voice DNC) is also set by an all-channel do_not_contact.
    do_not_call: (row.do_not_call ?? false) || dnc,
  }
}
