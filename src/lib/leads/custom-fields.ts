/**
 * Bridged-lead custom fields (DGS `/api/v1/leads` → `leads.custom_fields`).
 *
 * A doctor-referral web form captured in GHL carries rich detail — the
 * referring dentist, their practice, the reason for referral, and a clinical
 * note. Historically none of it reached LI: the bridge only ever wrote a
 * derived `{ treatment_interest }`, so referral leads looked like blank records
 * (see the ximalatl avalos trace, 2026-07-21). This module lets the bridge
 * persist those fields.
 *
 * Security posture mirrors `sanitizeCampaignAttribution`: an explicit ALLOW-LIST,
 * so a compromised bridge key can't turn the jsonb column into an arbitrary
 * dumping ground. DGS/GHL bridges must map their source fields onto these keys.
 * Extend the list when a new referral/clinical field genuinely needs to flow.
 */

/**
 * Keys mirror the GHL custom-field definitions on the Dion Health location
 * (`GET /locations/tCQuem…/customFields`, read 2026-07-21) so the contract is
 * the source schema rather than a guess:
 *
 *   Referring Doctor Name   -> referring_doctor_name
 *   NPI                     -> referring_doctor_npi
 *   Doctor Phone            -> referring_doctor_phone   (the DOCTOR's, not the practice's)
 *   Doctor Email            -> referring_doctor_email   (ditto)
 *   Name of practice        -> referring_practice
 *   Reason for Referral     -> referral_reason
 *   Urgency Level           -> referral_urgency
 *   Referral Notes          -> referral_notes
 *   Patient DOB             -> patient_dob
 */
export const CUSTOM_FIELD_KEYS = [
  'treatment_interest',
  'referring_doctor_name',
  'referring_doctor_npi',
  'referring_doctor_phone',
  'referring_doctor_email',
  'referring_practice',
  'referral_reason',
  'referral_urgency',
  'referral_notes',
  'patient_dob',
] as const

const MAX_VALUE_LEN = 2000

/**
 * Keep only allow-listed keys with usable string values (arrays of strings are
 * joined — GHL multi-selects arrive that way). Returns null when nothing
 * survives, so callers can conditionally spread it into the insert.
 */
export function sanitizeCustomFields(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const raw = v as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const k of CUSTOM_FIELD_KEYS) {
    const val = raw[k]
    if (typeof val === 'string' && val.trim()) {
      out[k] = val.trim().slice(0, MAX_VALUE_LEN)
    } else if (Array.isArray(val)) {
      const joined = val.filter((x) => typeof x === 'string' && x.trim()).map((x) => (x as string).trim()).join(', ')
      if (joined) out[k] = joined.slice(0, MAX_VALUE_LEN)
    }
  }
  return Object.keys(out).length ? out : null
}

/**
 * Merge sanitized incoming custom fields with the intake-derived service line.
 * The derived `treatment_interest` is authoritative (it comes from the landing
 * URL / form message), so it always wins over any incoming value. Returns null
 * when there is nothing to store.
 */
export function mergeCustomFields(
  incoming: Record<string, string> | null,
  treatmentInterest: string | null,
): Record<string, string> | null {
  const merged: Record<string, string> = {
    ...(incoming ?? {}),
    ...(treatmentInterest ? { treatment_interest: treatmentInterest } : {}),
  }
  return Object.keys(merged).length ? merged : null
}

/**
 * Dedup-hit back-fill: a re-POST of an existing lead (e.g. DGS re-syncs a
 * referral after its resolver runs) can enrich a lead that was first captured
 * bare. Add only the incoming keys the existing row is MISSING or has blank —
 * never clobber a value already set (mirrors the utm-column "fill when null"
 * policy). Returns the FULL object to write to `custom_fields`, or null when
 * nothing new would be added (so the caller skips the update).
 */
export function customFieldsDedupPatch(
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, string> | null | undefined,
): Record<string, string> | null {
  if (!incoming || !Object.keys(incoming).length) return null
  const base = (existing && typeof existing === 'object' && !Array.isArray(existing))
    ? (existing as Record<string, unknown>)
    : {}
  const merged: Record<string, unknown> = { ...base }
  let added = false
  for (const [k, v] of Object.entries(incoming)) {
    const cur = base[k]
    if (cur === undefined || cur === null || cur === '') {
      merged[k] = v
      added = true
    }
  }
  return added ? (merged as Record<string, string>) : null
}
