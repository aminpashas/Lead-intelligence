/**
 * Derived "signal" columns for the pipeline board.
 *
 * The stage columns on /pipeline come straight from `pipeline_stages`, but for
 * most of the book a lead's `stage_id` is a *GHL import label* that was set once
 * and never updated — which is why "New Lead" reads 10k+ when almost none of
 * those leads are actually new (they were contacted long ago). These derived
 * columns ignore the stale stage label and classify a lead by REAL, live signals
 * that already sit on the lead row:
 *
 *   - Untouched               → `first_contact_at IS NULL` (we've never reached out)
 *   - Active Communication    → `last_responded_at` within the recency window (a live two-way thread)
 *   - Financially Unqualified → assessed + lowest tier (money is the blocker)
 *
 * They are independent LENSES, not a partition: a lead can be both actively
 * talking and financially unqualified, so it may appear in two columns. They are
 * rendered read-only, so the drag-and-drop stage board is untouched.
 */

import type { Lead } from '@/types/database'

export type DerivedColumnKey = 'untouched' | 'active-comms' | 'financially-unqualified'

export interface DerivedColumnDef {
  key: DerivedColumnKey
  label: string
  /** One-line explainer under the header, so it reads as a live signal, not a stage. */
  description: string
}

export const DERIVED_COLUMNS: DerivedColumnDef[] = [
  {
    key: 'untouched',
    label: 'Untouched',
    description: 'Never contacted — no outreach has gone out yet.',
  },
  {
    key: 'active-comms',
    label: 'Active Communication',
    description: 'Replied within the last 14 days — a live two-way conversation.',
  },
  {
    key: 'financially-unqualified',
    label: 'Financially Unqualified',
    description: 'Assessed and unable to fund treatment at any tier.',
  },
]

/** How recently a lead must have replied to count as an active conversation. */
export const ACTIVE_COMMS_WINDOW_DAYS = 14

const DERIVED_COLUMN_KEYS = new Set<string>(DERIVED_COLUMNS.map((c) => c.key))

/** Type guard for an untrusted string (e.g. a `?signal=` URL param) before it
 *  reaches `applyDerivedFilter` — an unknown key would fall through the switch
 *  and return `undefined`, breaking the query. */
export function isDerivedColumnKey(value: string | null | undefined): value is DerivedColumnKey {
  return value != null && DERIVED_COLUMN_KEYS.has(value)
}

/**
 * Apply a derived column's WHERE predicate to a PostgREST `leads` query. This is
 * the SQL twin of `matchesDerivedColumn` — keep the two in sync so the exact
 * server count and the rendered card slice always agree.
 *
 * `cutoffIso` is the active-comms recency boundary (now − window), computed once
 * by the caller so a column's count query and card query share the same instant.
 * Org / stage / treatment scoping is applied by the caller, not here.
 *
 * The builder is chained through a local `any` because PostgREST's fluent type
 * doesn't survive a generic switch cleanly; the caller keeps the concrete type.
 */
export function applyDerivedFilter<Q>(query: Q, key: DerivedColumnKey, cutoffIso: string): Q {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = query as any
  switch (key) {
    case 'untouched':
      return q.is('first_contact_at', null).not('status', 'in', '("disqualified","lost")')
    case 'active-comms':
      // `gte` on a nullable column excludes NULLs, so never-replied leads drop out.
      return q.gte('last_responded_at', cutoffIso).not('status', 'in', '("disqualified","lost")')
    case 'financially-unqualified':
      // Money is the blocker regardless of sales status — count the TRUE
      // population (an already-disqualified tier_d lead still belongs here).
      return q
        .eq('financial_qualification_status', 'assessed')
        .eq('financial_qualification_tier', 'tier_d')
  }
}

/**
 * Client-side twin of `applyDerivedFilter`: does an already-loaded lead belong in
 * this column? Used only if a caller needs to classify in memory; the board
 * fetches each column with `applyDerivedFilter` directly, so both stay exact.
 */
export function matchesDerivedColumn(lead: Lead, key: DerivedColumnKey, cutoffMs: number): boolean {
  const dead = lead.status === 'disqualified' || lead.status === 'lost'
  switch (key) {
    case 'untouched':
      return lead.first_contact_at == null && !dead
    case 'active-comms':
      return (
        lead.last_responded_at != null &&
        Date.parse(lead.last_responded_at) >= cutoffMs &&
        !dead
      )
    case 'financially-unqualified':
      return (
        lead.financial_qualification_status === 'assessed' &&
        lead.financial_qualification_tier === 'tier_d'
      )
  }
}
