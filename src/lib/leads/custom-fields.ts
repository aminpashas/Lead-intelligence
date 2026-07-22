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

export const CUSTOM_FIELD_KEYS = [
  'treatment_interest',
  'referring_doctor',
  'referring_practice',
  'referring_practice_phone',
  'referring_practice_email',
  'referral_reason',
  'referral_priority',
  'referral_clinical_note',
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
