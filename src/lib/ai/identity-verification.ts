/**
 * Patient identity verification gate.
 *
 * HIPAA §164.514(h) requires verifying the identity of a person before
 * disclosing PHI to them. On inbound SMS/voice we only know the phone number,
 * which is NOT identity (shared phones, ported numbers, spoofing). This module
 * is the single source of truth for "is the caller allowed to hear case-specific
 * info yet?" — enforced at the data-access layer, not in the prompt.
 *
 * Flow:
 *   1. hasCaseData(lead)        → is there any PHI worth gating on this record?
 *   2. isVerificationActive(..) → has the caller already passed, recently?
 *   3. verifyDob(claim, ..)     → challenge/response to flip the flag
 *   4. buildSafeLeadContext honors the resulting `disclosePHI` decision.
 */

import { decryptField } from '@/lib/encryption'

/**
 * Tier-1 lead fields = case-specific PHI. These are STRIPPED from the model's
 * context until identity is verified, so the model cannot disclose what it never
 * received. (Tier-0 — first name, qualification, score, engagement counts — is
 * non-case-specific and always allowed.)
 */
export const TIER1_LEAD_FIELDS = [
  'dental_condition',
  'dental_condition_details',
  'current_dental_situation',
  'has_dentures',
  'financing_interest',
  'budget_range',
  'credit_range',
  'timeline_note',
  'date_of_birth',
  'insurance_provider',
  'insurance_details',
] as const

/**
 * How long a verified state stays valid on a conversation before the caller
 * must re-verify. Voice = one live session; text/email = a short per-thread
 * window. Anything that is not a live call uses the shorter `sms` bucket.
 */
export const VERIFICATION_TTL_MS = {
  voice: 15 * 60 * 1000,
  sms: 30 * 60 * 1000,
} as const

/**
 * Has this conversation been identity-verified recently enough to still count?
 * Reads `conversations.identity_verified_at`. Non-voice channels use the shorter
 * `sms` TTL bucket.
 */
export function isVerificationActive(
  verifiedAt: string | null | undefined,
  channel: string,
): boolean {
  if (!verifiedAt) return false
  const ttl = channel === 'voice' ? VERIFICATION_TTL_MS.voice : VERIFICATION_TTL_MS.sms
  const age = Date.now() - new Date(verifiedAt).getTime()
  return age >= 0 && age < ttl
}

/**
 * The top-level decision every patient-facing agent surface reads: may we
 * disclose Tier-1 PHI to whoever is on the other end right now?
 *
 * True when there is nothing to protect (no case data on the record yet) OR
 * identity has been verified within the TTL window.
 */
export function canDisclosePHI(args: {
  lead: Record<string, unknown>
  verifiedAt: string | null | undefined
  channel: string
}): boolean {
  if (!hasCaseData(args.lead)) return true // fresh lead — no PHI to gate yet
  return isVerificationActive(args.verifiedAt, args.channel)
}

/**
 * Statuses that mean "still a cold/marketing lead" — a form fill, some outreach,
 * maybe a qualification note, but no booked appointment or clinical record. Any
 * status NOT in this set (consultation_scheduled and beyond, incl. no_show which
 * implies a booked consult) means a real patient relationship exists.
 */
const NON_CASE_STATUSES: ReadonlySet<string> = new Set([
  'new',
  'contacted',
  'qualified',
  'unresponsive',
  'dormant',
  'lost',
  'disqualified',
])

/**
 * Does this lead hold case-specific PHI worth gating?
 *
 * Deliberately does NOT trip on ad-form self-reported fields (dental_condition,
 * budget_range, credit_range, financing_interest) — nearly every cold lead has
 * those, and gating on them would put a verification wall in front of the whole
 * funnel. It trips on signals that only exist once someone is a real prospect/
 * patient: a booked/attended consult, a financing application, insurance on
 * file, or a pipeline stage past qualification.
 *
 * Tune the triggers here if your compliance posture differs.
 */
export function hasCaseData(lead: Record<string, unknown>): boolean {
  const has = (k: string): boolean => {
    const v = lead[k]
    return v != null && v !== '' && v !== 'unknown'
  }
  if (has('consultation_date') || has('financing_application_id')) return true
  if (has('insurance_provider') || has('insurance_details')) return true
  const status = typeof lead.status === 'string' ? lead.status : ''
  if (status && !NON_CASE_STATUSES.has(status)) return true
  return false
}

// ────────────────────────────────────────────────────────────────────────────
// DOB challenge
// ────────────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
}

/** Validate and pack a Y/M/D triple, rejecting out-of-range values. */
function packDate(y: number, m: number, d: number): { y: number; m: number; d: number } | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null
  return { y, m, d }
}

/**
 * Parse a date of birth from either the stored format (ISO, possibly with a time
 * suffix) or a caller-spoken/typed format. Returns null for anything ambiguous
 * or unparseable — we would rather fail closed than guess day-vs-month.
 * Two-digit years are intentionally rejected (too ambiguous).
 */
function parseDob(raw: string): { y: number; m: number; d: number } | null {
  const s = raw.trim().toLowerCase()

  // ISO: YYYY-MM-DD (tolerate a trailing time, e.g. "1980-03-05T00:00:00")
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (m) return packDate(+m[1], +m[2], +m[3])

  // US numeric: MM/DD/YYYY (also -, .)
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/)
  if (m) return packDate(+m[3], +m[1], +m[2])

  // "Month D, YYYY" / "Month Dth YYYY"
  m = s.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/)
  if (m && MONTHS[m[1]]) return packDate(+m[3], MONTHS[m[1]], +m[2])

  // "D Month YYYY" / "Dth of Month YYYY"
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+),?\s+(\d{4})$/)
  if (m && MONTHS[m[2]]) return packDate(+m[3], MONTHS[m[2]], +m[1])

  return null
}

/**
 * Verify a caller-supplied date of birth against the encrypted DOB on file.
 * Returns true only on a confident, unambiguous match.
 */
export function verifyDob(
  claimed: string,
  encryptedDob: string | null | undefined,
): boolean {
  const onFile = decryptField(encryptedDob)
  if (!onFile || !claimed?.trim()) return false
  const a = parseDob(claimed)
  const b = parseDob(onFile)
  if (!a || !b) return false
  return a.y === b.y && a.m === b.m && a.d === b.d
}
