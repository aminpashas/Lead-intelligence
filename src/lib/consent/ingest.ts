/**
 * Consent ingest mapping — turns the DGS/GHL bridge's tri-state consent input
 * into the exact `leads` columns to write.
 *
 * Tri-state semantics (the whole point of Phase 1.1):
 *   true      → explicit opt-in   → status 'granted', boolean true, stamp + source
 *   false     → explicit decline  → status 'declined', boolean stays false
 *   undefined → no signal sent    → status 'unknown'  (eligible for consent-capture)
 *
 * We never write a boolean `false` — the column default is already false and the
 * consent GATE only ever allows on boolean `true`. "declined" vs "unknown" is
 * carried entirely by the status column so the gate's allow/deny logic is
 * unchanged. The DB trigger (sync_consent_status) keeps status consistent for
 * the opt-in/opt-out paths that only flip booleans.
 */

export type ConsentStatus = 'granted' | 'declined' | 'unknown'
export type ChannelInput = boolean | undefined

export function statusFromInput(v: ChannelInput): ConsentStatus {
  if (v === true) return 'granted'
  if (v === false) return 'declined'
  return 'unknown'
}

export interface ConsentIngestInput {
  sms_consent?: boolean
  email_consent?: boolean
  voice_consent?: boolean
  /** Where the consent decision came from, e.g. 'dgs_form', 'ghl_import'. */
  consent_source?: string | null
  /** ISO timestamp; injectable for deterministic tests. Defaults to now. */
  now?: string
}

/** Partial `leads` column set to merge into an insert/update payload. */
export interface ConsentIngestFields {
  sms_consent_status: ConsentStatus
  email_consent_status: ConsentStatus
  voice_consent_status: ConsentStatus
  sms_consent?: boolean
  email_consent?: boolean
  voice_consent?: boolean
  sms_consent_at?: string
  email_consent_at?: string
  voice_consent_at?: string
  sms_consent_source?: string
  email_consent_source?: string
  voice_consent_source?: string
}

const DEFAULT_SOURCE = 'dgs_bridge'

/**
 * Map tri-state consent input to the `leads` columns to write.
 * Only emits boolean/stamp/source for channels explicitly granted (true).
 */
export function deriveConsentFields(input: ConsentIngestInput): ConsentIngestFields {
  const ts = input.now ?? new Date().toISOString()
  const source = (input.consent_source && input.consent_source.trim()) || DEFAULT_SOURCE

  const fields: ConsentIngestFields = {
    sms_consent_status: statusFromInput(input.sms_consent),
    email_consent_status: statusFromInput(input.email_consent),
    voice_consent_status: statusFromInput(input.voice_consent),
  }

  if (input.sms_consent === true) {
    fields.sms_consent = true
    fields.sms_consent_at = ts
    fields.sms_consent_source = source
  }
  if (input.email_consent === true) {
    fields.email_consent = true
    fields.email_consent_at = ts
    fields.email_consent_source = source
  }
  if (input.voice_consent === true) {
    fields.voice_consent = true
    fields.voice_consent_at = ts
    fields.voice_consent_source = source
  }

  return fields
}
