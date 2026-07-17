/**
 * Phone-number-in-the-name-column classification.
 *
 * Upstream (GHL, and call-tracking via the DGS bridge) stores a contact's phone
 * number as its `name` when the contact was created without one. Every importer
 * we have then splits that "name" on whitespace, so the phone lands in the two
 * name columns:
 *
 *   "(925) 497-0821"  → first_name="(925)",      last_name="497-0821"
 *   "+52 675 108 4917" → first_name="+52",        last_name="675 108 4917"
 *   "5103315182 boyer" → first_name="5103315182", last_name="boyer"
 *
 * Every surface that shows a lead name then shows a phone number — the leads
 * table, pipeline cards, task titles ("Book (925) 497-0821 …") and, worst of
 * all, AI SMS personalization ("Hi (925),").
 *
 * Like `junk-contact.ts` this classifier is deliberately HIGH-PRECISION, but the
 * asymmetry is different and worth stating: a false positive here DESTROYS a
 * real patient's name (unrecoverable — the source row is upstream), while a
 * false negative just leaves one ugly card. So when in doubt: leave it alone.
 *
 * That is why the digit floor below exists. Prod sample (SF Dentistry, 2026-07):
 * a blanket "looks numeric → null it" rule would have wrongly eaten `Booth`/`14`,
 * `101`/`California`, `Elias`/`111` and `Ns`/`113107` — all real leads whose
 * name merely contains a number.
 *
 * This is the single source of truth for BOTH the ingest guard (so it cannot
 * recur) and the one-off backfill (so the two can never disagree).
 *
 * PERSISTENCE NOTE: `leads.first_name` is NOT NULL (`last_name` is nullable), so
 * callers must write `first ?? ''` — an empty first_name is how the schema spells
 * "no name". `leadDisplayName` treats '' and null identically, falling back to the
 * phone. This classifier still returns null rather than '' because null is the
 * honest answer; the storage compromise belongs at the write site, not here.
 */

/** Characters a phone number may be written with — digits and punctuation only.
 *  A token containing any letter is by definition not a bare phone number. */
const PHONE_CHARS = /^[0-9()+\-.\s]+$/

/** Count of actual digits in a token — punctuation carries no signal. */
function digitCount(value: string): number {
  return (value.match(/[0-9]/g) ?? []).length
}

/**
 * A token that could be a phone number or a fragment of one: punctuation and
 * digits only, and at least one digit. Note this is intentionally loose — "(925)"
 * and "14" both qualify. It says "contains no name", NOT "is a whole phone
 * number". Pairing rules below supply the confidence.
 */
function isPhoneToken(value: string | null | undefined): boolean {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return false
  return PHONE_CHARS.test(trimmed) && digitCount(trimmed) > 0
}

/**
 * Digits required before a phone-shaped token sitting NEXT TO A REAL NAME is
 * treated as a stray phone number rather than part of that name. 7 = a local
 * subscriber number ("606-2595"), the shortest thing that is unambiguously a
 * phone. Below this we keep the value: "Booth 14" and "Elias 111" are real.
 */
const LONE_TOKEN_DIGIT_FLOOR = 7

export type PhoneNamePair = {
  first: string | null | undefined
  last?: string | null | undefined
}

export type PhoneNameVerdict = {
  /** Scrubbed first name — null when it was a phone fragment. */
  first: string | null
  /** Scrubbed last name — null when it was a phone fragment. */
  last: string | null
  /** True when either column was scrubbed. */
  changed: boolean
}

/**
 * Strip phone numbers out of a first/last name pair, keeping any real name.
 *
 * Three cases, in precision order:
 *
 *  1. BOTH tokens are phone-shaped → the pair is one phone number that got split
 *     ("(925)" + "497-0821"). There is no name here at all; null both. No digit
 *     floor applies: neither half of a split number is a name on its own, and a
 *     short pair like "6966"/"8755" is still a phone fragment, never a person.
 *  2. Exactly ONE token is phone-shaped AND clears the digit floor → a real name
 *     with a stray number attached ("chris" + "606-2595"). Null only the number;
 *     the real name survives.
 *  3. Anything else → leave untouched. A number short enough to be part of a name
 *     ("Booth 14"), or a token with letters in it, is not ours to judge.
 */
export function scrubPhoneNames(pair: PhoneNamePair): PhoneNameVerdict {
  const first = (pair.first ?? '').trim() || null
  const last = (pair.last ?? '').trim() || null

  const firstIsPhone = isPhoneToken(first)
  const lastIsPhone = isPhoneToken(last)

  // 1) Split phone number across both columns — no name present.
  if (firstIsPhone && lastIsPhone) {
    return { first: null, last: null, changed: true }
  }

  // 2) Real name on one side, stray phone number on the other.
  if (firstIsPhone && !lastIsPhone && digitCount(first!) >= LONE_TOKEN_DIGIT_FLOOR) {
    return { first: null, last, changed: true }
  }
  if (lastIsPhone && !firstIsPhone && digitCount(last!) >= LONE_TOKEN_DIGIT_FLOOR) {
    return { first, last: null, changed: true }
  }

  // 3) Not confident — keep what we were given.
  return { first, last, changed: false }
}

/** Tag stamped on a lead whose name we scrubbed, so the front desk can tell
 *  "we never got a name" apart from "the name was lost". */
export const NAME_UNKNOWN_TAG = 'name-unknown'
