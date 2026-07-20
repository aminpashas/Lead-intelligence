/**
 * Lead hold — the single choke point for "is this lead paused right now?".
 *
 * A hold suppresses ALL outbound AUTOMATION until hold_until passes. It never
 * blocks a human-initiated action (the UI warns and lets the rep override) and
 * never suppresses inbound. Every outbound path routes through this module so
 * the predicate lives in exactly one place — see the spec's "choke point".
 *
 * The rule is deliberately trivial — hold_until IS NULL OR hold_until < now —
 * because task-sweep CLEARS an expired hold's column rather than leaving a stale
 * past date. So a non-null hold_until in the future is the only "on hold" state.
 */
import type { PostgrestFilterBuilder } from '@supabase/supabase-js'

/** The columns any query must select for isOnHold() to work. Spread into selects. */
export const HOLD_SELECT_COLUMNS = 'hold_until' as const

export type HoldableLead = { hold_until: string | null }

/** True when the lead is on hold at `now` (defaults to the current time). */
export function isOnHold(lead: HoldableLead, now: Date = new Date()): boolean {
  if (!lead.hold_until) return false
  return new Date(lead.hold_until).getTime() > now.getTime()
}

/**
 * Add the "not currently on hold" filter to a PostgREST leads query: keeps rows
 * whose hold_until is null OR already in the past. Mirrors the null-inclusive
 * .or() pattern used by last_contacted_before in smart-list-resolver.
 */
export function applyNotOnHold<T extends PostgrestFilterBuilder<any, any, any, any>>(
  query: T,
  now: Date = new Date(),
): T {
  return query.or(`hold_until.is.null,hold_until.lt.${now.toISOString()}`) as T
}
