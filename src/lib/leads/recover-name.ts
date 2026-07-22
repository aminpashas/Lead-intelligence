/**
 * Recover a lead's real name from an upstream system.
 *
 * WHY THIS EXISTS
 * ---------------
 * ~4,600 SF Dentistry leads carry no name. Almost none of them were nameless at
 * capture: upstream (GHL, and call tracking via the DGS bridge) writes a
 * contact's PHONE into its `name` when it has nothing better, every importer we
 * have split that on whitespace into `first_name`/`last_name`, and the
 * `scrub-phone-names` backfill then correctly nulled those columns rather than
 * keep texting patients "Hi (925),". Correct, but lossy — the scrub had no way
 * to ask the source what the patient is actually called.
 *
 * The name usually still exists upstream, in one of two places:
 *   • the CareStack `patients` roster, already mirrored into our own DB by the
 *     EHR sync and linked to the lead — no API call needed, just a join we
 *     never made; and
 *   • the GHL contact behind the lead's `ghl_opp:` external_ref.
 *
 * This module is the pure decision layer: given candidate names from those
 * sources, decide which (if any) is a real human name safe to write back.
 *
 * THE ONE RULE THAT MATTERS
 * -------------------------
 * Never put a phone number back into a name column. That is the exact defect the
 * scrub was run to fix, and a recovery pass is the obvious way to reintroduce it
 * — upstream `name` fields are precisely where the phone numbers came from. So
 * every candidate is run through `scrubPhoneNames`, the same classifier used by
 * the ingest guard and the scrub itself, and only what survives it is returned.
 * Placeholders ("Unknown", "Wireless Caller") are dropped for the same reason:
 * writing them back would relabel the patient without informing anyone.
 */

import { scrubPhoneNames } from './phone-name'
import { PLACEHOLDER_NAMES } from './junk-contact'

/** A name as some upstream system holds it. `full` covers sources (GHL) that
 *  only expose a single combined string. */
export type NameCandidate = {
  /** Where it came from — echoed back so the caller can log/audit provenance. */
  source: string
  first?: string | null
  last?: string | null
  full?: string | null
}

/**
 * A name judged safe to write back. `first` may be null while `last` is set:
 * "5103315182 boyer" recovers the surname only. `leads.first_name` is NOT NULL,
 * so the write site stores `first ?? ''` — see the persistence note in
 * `phone-name.ts`.
 */
export type RecoveredName = {
  first: string | null
  last: string | null
  source: string
}

/** Split a combined "Jane Q Public" into first + everything-else. */
function splitFull(full: string): { first: string; last: string | null } {
  const parts = full.trim().split(/\s+/)
  return { first: parts[0], last: parts.length > 1 ? parts.slice(1).join(' ') : null }
}

function norm(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Evaluate one candidate. Returns null when it holds no usable human name.
 *
 * Exported for its own tests — the rejection cases (a phone, a placeholder, an
 * email address someone typed into the name box) are the whole point of this
 * module and deserve to be pinned down individually.
 */
export function evaluateCandidate(candidate: NameCandidate): RecoveredName | null {
  const explicit = (candidate.first ?? '').trim() || (candidate.last ?? '').trim()
  const { first, last } = explicit
    ? { first: (candidate.first ?? '').trim(), last: (candidate.last ?? '').trim() || null }
    : splitFull(candidate.full ?? '')

  const combined = norm([first, last].filter(Boolean).join(' '))
  if (!combined) return null

  // A carrier placeholder is not a name, however confidently upstream stores it.
  if (PLACEHOLDER_NAMES.has(combined) || PLACEHOLDER_NAMES.has(norm(first))) return null

  // An email in the name box is a real identity but the wrong field; writing it
  // would render "Hi jane@example.com," in outbound SMS.
  if (combined.includes('@')) return null

  // The load-bearing check: strip anything phone-shaped using the SAME
  // classifier as the ingest guard, so recovery and prevention can never
  // disagree about what counts as a phone number.
  const scrubbed = scrubPhoneNames({ first, last })
  if (!scrubbed.first && !scrubbed.last) return null

  return { first: scrubbed.first, last: scrubbed.last, source: candidate.source }
}

/**
 * Pick the best recoverable name from candidates given in PRIORITY ORDER.
 *
 * Order is the caller's call, and it is a judgement about trust, not freshness:
 * CareStack is the clinical record a human typed at the front desk, so it
 * outranks a GHL contact that may itself have been auto-filled from caller ID.
 */
export function recoverLeadName(candidates: NameCandidate[]): RecoveredName | null {
  for (const candidate of candidates) {
    const recovered = evaluateCandidate(candidate)
    if (recovered) return recovered
  }
  return null
}
