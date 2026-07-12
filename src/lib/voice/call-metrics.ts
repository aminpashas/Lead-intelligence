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
}

/** Statuses that mean "a call is happening right now". */
export const ACTIVE_CALL_STATUSES = ['initiated', 'ringing', 'in_progress'] as const

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
      return q.in('status', ACTIVE_CALL_STATUSES) as Q
  }
}
