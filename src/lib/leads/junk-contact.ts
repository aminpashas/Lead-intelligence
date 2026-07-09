/**
 * Junk caller-ID classification for call-tracking inbound (WhatConverts, voice).
 *
 * WhatConverts creates a "lead" for EVERY inbound call to a tracked number and
 * maps the caller-ID string into first_name/last_name. When the caller ID
 * carries no real name, that string is location or carrier noise:
 *
 *   "CLEVELAND OH"  → first_name="Cleveland", last_name="Oh"   (city + state)
 *   "CHICAGO IL"    → first_name="Chicago",   last_name="Il"
 *   "WIRELESS CALLER" / "TOLL FREE" / "UNKNOWN"                (carrier placeholder)
 *
 * These are NOT prospects and pollute the New-Lead pipeline. This classifier is
 * deliberately HIGH-PRECISION: a false positive buries a real prospect, a false
 * negative just leaves one extra card to triage. So it fires ONLY when there is
 * no reachable contact AND the name is unambiguous caller-ID noise. A caller
 * with a real-looking name but no email/valid phone (e.g. "Newman,diane") is
 * NOT junk — it stays a lead.
 *
 * Existing-patient calls are handled separately (patient-lookup.ts) — this is
 * only about calls from nobody we can identify.
 */

/** US state + territory two-letter codes. A name whose 2nd token is one of these
 *  is a "City ST" caller-ID location, never a person's surname. */
const US_STATE_CODES = new Set([
  'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia','ks',
  'ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny',
  'nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt','va','wa','wv',
  'wi','wy','dc','pr','vi','gu','as','mp',
])

/** Business / insurer / other-practice caller-ID names. A person is never named
 *  "Delta Dental" or "Kaiser Permanente" — these are vendors, insurers, or other
 *  dental offices calling the practice, not prospects. Matched as whole words so
 *  a real surname is never clipped. High-precision (prod sample: all orgs). This
 *  is the tunable list — add insurers / chains as they show up. */
// NOTE: "kaiser" is required as the phrase "kaiser permanen*" (the insurer) — a
// bare "kaiser" is a real surname ("Syed Kaiser"). Same care with any token that
// doubles as a name: prefer the unambiguous multi-word form.
const BUSINESS_KEYWORDS =
  /\b(dental|dentist|dentistry|orthodont\w*|endodont\w*|periodont\w*|prosthodont\w*|invisalign|pharmacy|clinic|hospital|medical|medicaid|medicare|insurance|kaiser permanen\w*|aetna|cigna|metlife|humana|anthem|delta ?dental|unitedhealth\w*|healthplan|health plan|llc|\binc\b)\b/

/** Carrier / telco placeholder names a caller ID returns when there's no name. */
const PLACEHOLDER_NAMES = new Set([
  'unknown','anonymous','restricted','private','unavailable','no name',
  'wireless caller','wireless','cell phone','toll free','tollfree','spam',
  'spam risk','scam likely','potential spam','v mail','voicemail','no caller id',
  'name unavailable','unknown caller','unknown name','out of area',
])

export type JunkContactInput = {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  /** true only when the number passed validation; false/null/undefined = unreachable */
  phone_valid?: boolean | null
  /** normalized source, e.g. 'whatconverts' | 'voice' */
  source_type?: string | null
}

/** Sources that map a raw caller-ID string into the name fields. Only these can
 *  produce caller-ID noise; a web form / GHL submission has a real typed name. */
const CALL_TRACKING_SOURCES = new Set(['whatconverts', 'voice', 'callrail'])

function norm(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Decide whether an inbound contact is junk caller-ID noise rather than a lead.
 *
 * ── This is the tunable business rule. ─────────────────────────────────────
 * Widen it (e.g. also treat comma-formatted no-contact callers as junk) or
 * tighten it here; everything downstream just consumes the boolean.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * `phone_valid === true` is the one hard keep — a reachable number is never junk,
 * whatever the name. Otherwise (false OR unknown) the name shape decides. We do
 * NOT gate on phone_valid === false: in practice the column is almost never
 * populated (validated against prod: 0 valid / 636 false / 10,748 null), so
 * gating on it would disable the rule entirely.
 *
 * The "City ST" shape collides with rare real surnames ("Jane Oh", "Amy Le"), so
 * it is not perfectly precise — but a prod sample was 30/30 real cities /
 * placeholders, and matches are PARKED, not deleted (reversible via ?include=all),
 * so the shape alone is an acceptable, high-recall signal.
 */
export function isJunkCallerContact(input: JunkContactInput): boolean {
  // 1) Only call-tracking sources can carry caller-ID noise.
  if (!CALL_TRACKING_SOURCES.has(norm(input.source_type))) return false

  // 2) A real email is a real identity — always keep.
  if (input.email && input.email.trim()) return false

  // 3) A confirmed-valid phone means we can follow up — keep regardless of name.
  if (input.phone_valid === true) return false

  const first = norm(input.first_name)
  const last = norm(input.last_name)
  const full = [first, last].filter(Boolean).join(' ').trim()

  // 4a) Empty / no-name and unreachable.
  if (!full) return true

  // 4b) Exact carrier/telco placeholder ("Wireless Caller", "Unknown", ...).
  //     Unambiguous — safe even when phone validity is still unknown.
  if (PLACEHOLDER_NAMES.has(full) || PLACEHOLDER_NAMES.has(first)) return true

  // 4c) "City ST" / "City Name ST" location string — last token is a US state
  //     code and the whole name is 2–3 tokens (a caller-ID location, e.g.
  //     "Cleveland Oh", "San Rafael Ca"). Fires whenever unreachable (we already
  //     returned on phone_valid === true).
  const tokens = full.split(' ')
  if (tokens.length >= 2 && tokens.length <= 3 && US_STATE_CODES.has(tokens[tokens.length - 1])) {
    return true
  }

  // 4d) Business / insurer / other-practice name (vendor or insurer call, not a
  //     prospect). Whole-word match so a real surname is never clipped.
  if (BUSINESS_KEYWORDS.test(full)) return true

  return false
}
