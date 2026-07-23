/**
 * Duplicate DETECTION for existing leads (the review side of dedup).
 *
 * `lib/leads/dedupe.ts` + `lib/leads/identities.ts` PREVENT duplicates at ingest
 * by exact email/phone hash and shared correlation id. What they can't catch is
 * the pair that already sits in the table with DIFFERENT contact details — the
 * same person who filled a form twice from two numbers, a nickname vs a legal
 * name, a typo'd email. Those survive precisely because no exact key matches, so
 * they need a human to confirm. This module finds the candidates; a person (or
 * the admin merge flow) decides.
 *
 * Two halves:
 *   - `scoreDuplicatePair` — PURE. Given two leads, which signals line up and how
 *     confident are we they're the same person. Unit-testable without a DB.
 *   - `findDuplicateCandidates` — the query that gathers a lead's plausible
 *     twins (by exact phone/email hash, by shared identity, by matching name)
 *     and scores each.
 *
 * See [[leads-phone-dup-softmerge]], [[lead-identities-social-dedup]].
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeName } from '@/lib/leads/social-name-match'

/** Which piece of evidence links two leads. */
export type DuplicateSignal = 'phone' | 'email' | 'identity' | 'name'

/** How strongly we believe a candidate pair is the same person. */
export type DuplicateConfidence = 'high' | 'medium' | 'low'

/** The lead shape scoring needs — a subset of the row. */
export type ScorableLead = {
  id: string
  first_name: string | null
  last_name: string | null
  email_hash: string | null
  phone_hash: string | null
  status: string | null
  source_type: string | null
  /** Bare identity values (Meta PSID / GHL contact id / DGS lead id) on the row. */
  identityValues?: string[]
}

export type DuplicatePair = {
  signals: DuplicateSignal[]
  confidence: DuplicateConfidence
  /** 0–100. Ordering hint for the review queue; NOT a merge authorization. */
  score: number
}

/** Leads that carry no comparable signal at all — nothing to match on. */
function shareNothing(a: ScorableLead, b: ScorableLead): boolean {
  return (
    !(a.phone_hash && a.phone_hash === b.phone_hash) &&
    !(a.email_hash && a.email_hash === b.email_hash) &&
    normalizeName(a.first_name, a.last_name) !==
      normalizeName(b.first_name, b.last_name) &&
    !sharesIdentity(a, b)
  )
}

function sharesIdentity(a: ScorableLead, b: ScorableLead): boolean {
  const bv = new Set(b.identityValues ?? [])
  return (a.identityValues ?? []).some((v) => bv.has(v))
}

/** Which signals two leads share. Order is stable for display. */
export function matchingSignals(a: ScorableLead, b: ScorableLead): DuplicateSignal[] {
  const out: DuplicateSignal[] = []
  if (a.phone_hash && a.phone_hash === b.phone_hash) out.push('phone')
  if (a.email_hash && a.email_hash === b.email_hash) out.push('email')
  if (sharesIdentity(a, b)) out.push('identity')
  const an = normalizeName(a.first_name, a.last_name)
  if (an && an === normalizeName(b.first_name, b.last_name)) out.push('name')
  return out
}

/**
 * ── DECISION POINT ──────────────────────────────────────────────────────────
 * How confident are we that a candidate pair is really the same person?
 *
 * This is the false-positive knob, not a technical detail. Getting it wrong in
 * either direction has a real cost:
 *
 *   • Too eager (surface/merge weak matches) → staff are shown two different
 *     people who happen to share a name ("gabriel banon" with two different
 *     phone numbers is a real row in this org). If someone merges those, one
 *     person's texts, appointments and consent land on the other's record.
 *     Name collisions are common across 48k+ leads.
 *   • Too shy (only ever trust exact hashes) → the whole feature is redundant
 *     with the ingest-time dedup that already catches exact matches. The pairs
 *     worth a human's attention are exactly the fuzzy ones.
 *
 * Signals available (see `matchingSignals`):
 *   - 'phone'    same phone_hash. Strong — but households legitimately share a
 *                line (see contact-conflict.ts), so it is NOT proof by itself.
 *   - 'email'    same email_hash. Strong; email is close to a personal key.
 *   - 'identity' same Meta PSID / GHL contact id / DGS lead id. Strong — an
 *                exact id in a namespace that belongs to one person.
 *   - 'name'     same normalized name. Weak alone; meaningful as a tie-breaker.
 *
 * Worth weighing when you tune this:
 *   - Should a shared email OR identity be 'high' on its own, but a shared phone
 *     only 'high' when it ALSO shares a name (to survive the household case)?
 *   - Is name-only ever worth surfacing, or pure noise at this scale?
 *   - Does a shared source_type make a name match more trustworthy (same form,
 *     same campaign) or less (a batch import re-using a placeholder name)?
 *
 * DEFAULT POLICY (conservative — tune to how the practice actually works):
 *   high   : email or identity match; OR phone AND name together.
 *   medium : phone alone (household-line risk), or two weak signals.
 *   low    : name only.
 * Callers surface `high` freely, gate `medium` behind an explicit review, and
 * (by default) drop `low`.
 */
export function classifyConfidence(
  signals: DuplicateSignal[],
  ctx?: { sameSourceType?: boolean },
): DuplicateConfidence {
  const has = (s: DuplicateSignal) => signals.includes(s)

  if (has('email') || has('identity')) return 'high'
  if (has('phone') && has('name')) return 'high'
  if (has('phone')) return 'medium'
  if (has('name') && ctx?.sameSourceType) return 'medium'
  return 'low'
}

const CONFIDENCE_SCORE: Record<DuplicateConfidence, number> = {
  high: 90,
  medium: 60,
  low: 30,
}

/**
 * Score a candidate pair. Pure. Returns `null` when the two leads share no
 * comparable signal at all (nothing to be a duplicate on).
 */
export function scoreDuplicatePair(a: ScorableLead, b: ScorableLead): DuplicatePair | null {
  if (a.id === b.id) return null
  if (shareNothing(a, b)) return null

  const signals = matchingSignals(a, b)
  const confidence = classifyConfidence(signals, {
    sameSourceType: Boolean(a.source_type && a.source_type === b.source_type),
  })
  // A matched name on top of a contact/identity signal is corroborating; nudge
  // the ordering score without changing the confidence class.
  const nameBonus = signals.includes('name') && signals.length > 1 ? 5 : 0
  return {
    signals,
    confidence,
    score: Math.min(100, CONFIDENCE_SCORE[confidence] + nameBonus),
  }
}

// ── Query ──────────────────────────────────────────────────────────────────

/** A scored candidate, ready for the banner / review queue. */
export type DuplicateCandidate = ScorableLead & {
  created_at: string
  pair: DuplicatePair
}

/** Row columns the candidate query selects. */
const CANDIDATE_COLS =
  'id, first_name, last_name, email_hash, phone_hash, status, source_type, created_at, custom_fields'

type RawLeadRow = {
  id: string
  first_name: string | null
  last_name: string | null
  email_hash: string | null
  phone_hash: string | null
  status: string | null
  source_type: string | null
  created_at: string
  custom_fields: Record<string, unknown> | null
}

/** A lead that has already been merged away is not a live duplicate candidate. */
function isMergedAway(row: RawLeadRow): boolean {
  return Boolean(row.custom_fields && row.custom_fields.merged_into)
}

/**
 * Find plausible duplicates of `leadId` within its org, scored and sorted
 * (highest confidence first). Excludes the lead itself and any row that has
 * already been merged away.
 *
 * Three cheap indexed lookups (phone_hash, email_hash, shared identity value)
 * plus a name pass, unioned and de-duplicated. `minConfidence` lets the banner
 * ask for 'medium' while the task sweep can insist on 'high'.
 */
export async function findDuplicateCandidates(
  supabase: SupabaseClient,
  organizationId: string,
  leadId: string,
  opts: { minConfidence?: DuplicateConfidence } = {},
): Promise<DuplicateCandidate[]> {
  const { data: baseRow } = await supabase
    .from('leads')
    .select(CANDIDATE_COLS)
    .eq('id', leadId)
    .eq('organization_id', organizationId)
    .maybeSingle<RawLeadRow>()

  if (!baseRow) return []

  // The base lead's identity values, so we can find rows sharing any of them.
  const { data: baseIdentities } = await supabase
    .from('lead_identities')
    .select('value')
    .eq('organization_id', organizationId)
    .eq('lead_id', leadId)
  const baseIdentityValues = (baseIdentities ?? []).map((r) => String(r.value))

  const base: ScorableLead = { ...baseRow, identityValues: baseIdentityValues }

  // Gather candidate rows from every angle, keyed by id so a lead matching on
  // two signals is fetched once.
  const byId = new Map<string, RawLeadRow>()
  const collect = (rows: RawLeadRow[] | null) => {
    for (const r of rows ?? []) {
      if (r.id === leadId || isMergedAway(r)) continue
      byId.set(r.id, r)
    }
  }

  // The Supabase query builder is a thenable (PromiseLike), not a real Promise.
  const lookups: PromiseLike<unknown>[] = []

  if (baseRow.phone_hash) {
    lookups.push(
      supabase
        .from('leads')
        .select(CANDIDATE_COLS)
        .eq('organization_id', organizationId)
        .eq('phone_hash', baseRow.phone_hash)
        .neq('id', leadId)
        .limit(25)
        .then(({ data }) => collect(data as RawLeadRow[] | null)),
    )
  }
  if (baseRow.email_hash) {
    lookups.push(
      supabase
        .from('leads')
        .select(CANDIDATE_COLS)
        .eq('organization_id', organizationId)
        .eq('email_hash', baseRow.email_hash)
        .neq('id', leadId)
        .limit(25)
        .then(({ data }) => collect(data as RawLeadRow[] | null)),
    )
  }
  // Same normalized name. `ilike` on first_name is index-friendly and narrows
  // before the exact normalized-name filter runs in JS.
  if (baseRow.first_name) {
    lookups.push(
      supabase
        .from('leads')
        .select(CANDIDATE_COLS)
        .eq('organization_id', organizationId)
        .ilike('first_name', baseRow.first_name)
        .neq('id', leadId)
        .limit(50)
        .then(({ data }) => collect(data as RawLeadRow[] | null)),
    )
  }

  await Promise.all(lookups)

  // Rows sharing one of the base lead's identity values (separate table).
  const identityLeadIds = new Set<string>()
  if (baseIdentityValues.length) {
    const { data: sharing } = await supabase
      .from('lead_identities')
      .select('lead_id, value')
      .eq('organization_id', organizationId)
      .in('value', baseIdentityValues)
    for (const r of sharing ?? []) {
      const id = String(r.lead_id)
      if (id !== leadId) identityLeadIds.add(id)
    }
    const missing = [...identityLeadIds].filter((id) => !byId.has(id))
    if (missing.length) {
      const { data } = await supabase
        .from('leads')
        .select(CANDIDATE_COLS)
        .eq('organization_id', organizationId)
        .in('id', missing)
      collect(data as RawLeadRow[] | null)
    }
  }

  const minRank = CONFIDENCE_SCORE[opts.minConfidence ?? 'low']

  const scored: DuplicateCandidate[] = []
  for (const row of byId.values()) {
    const cand: ScorableLead = {
      ...row,
      identityValues: identityLeadIds.has(row.id) ? baseIdentityValues : [],
    }
    const pair = scoreDuplicatePair(base, cand)
    if (!pair) continue
    if (CONFIDENCE_SCORE[pair.confidence] < minRank) continue
    scored.push({ ...cand, created_at: row.created_at, pair })
  }

  return scored.sort((a, b) => b.pair.score - a.pair.score)
}
