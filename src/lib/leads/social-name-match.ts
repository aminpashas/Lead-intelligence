/**
 * Last-resort name matching for social DMs.
 *
 * WHY THIS EXISTS: `lead_identities` collapses the ingest paths that share an id
 * namespace. It cannot help when they share none — which is the live gap: the
 * DGS bridge stamps its own uuid and the GHL mirror stamps a GHL contact id, so
 * the SAME person arriving down both paths still produces two leads. That is
 * exactly how the 2026-07-20 Messenger duplicates happened.
 *
 * With no phone, no email and no shared id, the only remaining signal is the
 * Meta display name. That is weak evidence, so this module is deliberately the
 * LAST pass — it runs only after identity and contact-hash both miss, and only
 * for social channels. Never wire it into the general ingest path: name
 * collisions among 48k+ leads are common, and a false merge on a contactable
 * lead attaches a stranger's DM to a real patient record.
 *
 * See [[lead-identities-social-dedup]] and migration 20260720000000.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type NameMatchCandidate = {
  id: string
  first_name: string | null
  last_name: string | null
  /** True when the lead has a phone or email — i.e. a real contactable record. */
  hasContactInfo: boolean
  /** Lead age in days. Older records are more likely to be the "real" one. */
  ageDays: number
}

/** Normalize for comparison: casefold, collapse whitespace, strip punctuation. */
export function normalizeName(first: string | null, last: string | null): string {
  return `${first ?? ''} ${last ?? ''}`
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Decide whether an inbound social DM should ATTACH to an existing lead rather
 * than mint a new one.
 *
 * This is the judgement call, and it is a genuine trade-off:
 *
 *   • Attach too eagerly → two different people named "Tara Nguyen" become one
 *     record. A stranger's DM lands on a real patient's timeline, and staff may
 *     reply with that patient's context. Hard to detect, worse than a duplicate.
 *   • Attach too rarely → the DGS/GHL duplicate problem persists, which is the
 *     thing we set out to fix.
 *
 * Things worth weighing:
 *   - Require BOTH a first and a last name? A single-token display name
 *     ("Alex") is far too weak to merge on.
 *   - Should a candidate WITH contact info be harder to attach to than a thin
 *     contactless shell? Merging two thin social rows is low-risk and is the
 *     common case; merging onto a real patient record is the risky one.
 *   - Should more than one candidate mean "attach to none"? An ambiguous match
 *     is arguably evidence that the name is too common to trust at all.
 *   - Does lead age matter, or only contact info?
 *
 * POLICY (deliberately conservative — it fixes the observed failure without
 * ever touching the dangerous case):
 *
 *   1. Require at least two name tokens. A single-token display name ("Alex")
 *      is far too weak to merge two people on.
 *   2. Require exactly ONE candidate. Ambiguity is itself evidence that the
 *      name is too common to trust — ranking rivals would be guessing.
 *   3. Refuse any candidate that HAS a phone or email. Those are real,
 *      contactable records; attaching a stranger's DM to one is worse and far
 *      less detectable than leaving a duplicate. Staff can still merge by hand.
 *
 * Rule 3 is what makes this safe to run automatically. The duplicates this was
 * built for (the 2026-07-20 DGS↔GHL pairs) were BOTH contactless shells, so
 * they attach cleanly; the one risky merge in that batch — a DM onto a real
 * patient record with a phone and email — is exactly what rule 3 declines.
 *
 * @param incoming  normalized name from the DM
 * @param candidates in-org leads whose normalized name equals `incoming`
 * @returns the lead id to attach to, or null to mint a new lead
 */
export function pickNameMatch(
  incoming: string,
  candidates: NameMatchCandidate[],
): string | null {
  if (incoming.split(' ').filter(Boolean).length < 2) return null
  if (candidates.length !== 1) return null
  const [only] = candidates
  if (only.hasContactInfo) return null
  return only.id
}

/**
 * Fetch in-org leads whose normalized name equals the incoming display name.
 *
 * Deliberately returns ALL matches rather than `.limit(1)` so `pickNameMatch`
 * can see ambiguity and refuse.
 */
export async function findNameMatchCandidates(
  supabase: SupabaseClient,
  organizationId: string,
  first: string,
  last: string | null,
): Promise<NameMatchCandidate[]> {
  const target = normalizeName(first, last)
  if (!target) return []

  const { data } = await supabase
    .from('leads')
    .select('id, first_name, last_name, phone_hash, email_hash, created_at')
    .eq('organization_id', organizationId)
    .ilike('first_name', first)

  const now = Date.now()
  return (data ?? [])
    .filter((r) => normalizeName(r.first_name, r.last_name) === target)
    .map((r) => ({
      id: String(r.id),
      first_name: r.first_name,
      last_name: r.last_name,
      hasContactInfo: Boolean(r.phone_hash || r.email_hash),
      ageDays: (now - new Date(r.created_at as string).getTime()) / 86_400_000,
    }))
}
