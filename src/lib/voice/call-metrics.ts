/**
 * Call Center stat-card definitions.
 *
 * The four cards on /call-center (Today's Calls, Connected, Appointments,
 * Live Now) are each just a filter over `voice_calls`. Both the count shown on
 * the card AND the drill-down list behind it run through `applyCallMetric` so
 * the list length can never drift from the number on the badge.
 */

export type CallMetric = 'today' | 'connected' | 'appointments' | 'active'

export const CALL_METRICS: readonly CallMetric[] = ['today', 'connected', 'appointments', 'active']

export const CALL_METRIC_LABELS: Record<CallMetric, string> = {
  today: "Today's Calls",
  connected: 'Connected',
  appointments: 'Appointments',
  active: 'Live Now',
}

export function isCallMetric(value: string | null): value is CallMetric {
  return value !== null && (CALL_METRICS as readonly string[]).includes(value)
}

/** Start of the current day in ISO — the boundary the "today" metrics filter on. */
export function startOfTodayISO(): string {
  const t = new Date()
  t.setHours(0, 0, 0, 0)
  return t.toISOString()
}

// Minimal shape of a Supabase PostgREST filter builder — enough to chain the
// filters below without pulling in @supabase/postgrest-js internal generics.
type Chainable = {
  eq: (column: string, value: unknown) => Chainable
  gt: (column: string, value: unknown) => Chainable
  gte: (column: string, value: unknown) => Chainable
  in: (column: string, values: readonly unknown[]) => Chainable
  is: (column: string, value: unknown) => Chainable
}

/** Statuses that mean "a call is happening right now". */
export const ACTIVE_CALL_STATUSES = ['initiated', 'ringing', 'in_progress'] as const

/**
 * How long a row may sit in an active status before "Live Now" stops trusting it.
 * A real call — even a long AI voice call — is over well inside this window, so a
 * row older than this with no terminal event is a stranded phantom (missed
 * webhook), not a live call. The voice-reconcile cron heals such rows out of band;
 * this bound just makes sure the UI never advertises them as live in the meantime.
 * Comfortably larger than the reconciler's 10-min grace so the two never fight.
 */
export const ACTIVE_CALL_MAX_AGE_MINUTES = 30

/** ISO cutoff: rows created before this are too old to count as "live". */
export function activeCallFreshnessCutoffISO(): string {
  return new Date(Date.now() - ACTIVE_CALL_MAX_AGE_MINUTES * 60 * 1000).toISOString()
}

/**
 * Narrow a `voice_calls` query to the rows a given stat card counts.
 * Callers pass a query already scoped to the organization.
 *
 * `Q` is intentionally unconstrained: constraining it to `Chainable` makes
 * TypeScript relate it structurally against Supabase's deep relational-select
 * builder type and blow the recursion limit (TS2589). We cast to `Chainable`
 * once internally instead, and hand the caller's exact builder type back out so
 * `.order()`/`.limit()`/`await` stay fully typed.
 */
export function applyCallMetric<Q>(query: Q, metric: CallMetric, todayISO: string): Q {
  const q = query as Chainable
  switch (metric) {
    case 'today':
      return q.gte('created_at', todayISO) as Q
    case 'connected':
      return q.eq('status', 'completed').gt('duration_seconds', 0).gte('created_at', todayISO) as Q
    case 'appointments':
      return q.eq('outcome', 'appointment_booked').gte('created_at', todayISO) as Q
    case 'active':
      // "Happening right now" = active status AND not yet finalized AND recent
      // enough to plausibly still be live. The last two guards keep rows whose
      // terminal webhook never arrived from showing as phantom live calls.
      return q
        .in('status', ACTIVE_CALL_STATUSES)
        .is('ended_at', null)
        .gte('created_at', activeCallFreshnessCutoffISO()) as Q
  }
}
