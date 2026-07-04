/**
 * Transfer Routing — where an answered call goes, given the current time.
 *
 * Pure, I/O-free logic so it's deterministic and testable. The broker and the
 * dispatcher both call `resolveTransferCandidates` to turn the org's routing
 * rules into an ordered list of transfer-target ids to try (plus an overflow
 * list used when the in-window targets are all busy).
 *
 * Time handling reuses `getLocalHourAndDay` (Intl-based, DST-correct) — the same
 * primitive the campaign send-window uses — so we never have two divergent
 * "what hour is it there" code paths.
 */

import { getLocalHourAndDay } from '@/lib/autopilot/config'
import type { VoiceTransferRoute } from '@/types/database'

const DAY_NAME_TO_NUM: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
}

/**
 * Does this route's day+hour window contain `now` (in the route's timezone)?
 * end_hour is exclusive so a 9–18 route covers 09:00:00–17:59:59 local.
 */
export function routeMatchesNow(route: VoiceTransferRoute, now: Date = new Date()): boolean {
  if (!route.active) return false
  const tz = route.timezone || 'America/New_York'
  const { hour, day } = getLocalHourAndDay(tz, now)

  const allowedDays = (route.active_days || []).map(d => DAY_NAME_TO_NUM[d.toLowerCase()])
  if (!allowedDays.includes(day)) return false

  return hour >= route.start_hour && hour < route.end_hour
}

export type ResolvedTransferCandidates = {
  /** Ordered target ids to try first (from the matching in-window, non-overflow routes). */
  primary: string[]
  /** Ordered target ids to spill to when every primary target is busy (concierge/answering service). */
  overflow: string[]
  /** The primary routes that matched — useful for logging/telemetry. */
  matchedRouteIds: string[]
}

/**
 * Turn the org's routing rules into ordered candidate target lists for `now`.
 *
 * Primary candidates come from every non-overflow route whose window matches,
 * evaluated in ascending `priority`, de-duplicated (a target listed in two
 * matching windows is only tried once, at its earliest position).
 *
 * Overflow candidates come from routes flagged `is_overflow`. Overflow routes
 * are NOT time-gated by default so an all-busy situation always has somewhere to
 * spill — but if an overflow route DOES define a window, we honor it.
 */
export function resolveTransferCandidates(
  routes: VoiceTransferRoute[],
  now: Date = new Date()
): ResolvedTransferCandidates {
  const primary: string[] = []
  const overflow: string[] = []
  const matchedRouteIds: string[] = []
  const seenPrimary = new Set<string>()
  const seenOverflow = new Set<string>()

  const byPriority = [...routes].sort((a, b) => a.priority - b.priority)

  for (const route of byPriority) {
    if (route.is_overflow) {
      // Overflow with no explicit days = always eligible; with days = honor them.
      const eligible = !route.active
        ? false
        : route.active_days && route.active_days.length > 0
          ? routeMatchesNow(route)
          : true
      if (!eligible) continue
      for (const id of route.target_ids) {
        if (!seenOverflow.has(id)) { seenOverflow.add(id); overflow.push(id) }
      }
      continue
    }

    if (!routeMatchesNow(route, now)) continue
    matchedRouteIds.push(route.id)
    for (const id of route.target_ids) {
      if (!seenPrimary.has(id)) { seenPrimary.add(id); primary.push(id) }
    }
  }

  return { primary, overflow, matchedRouteIds }
}

/**
 * How many NEW leads to dial this dispatcher tick.
 *
 * Progressive dialing (dial_ratio = 1.0) dials exactly one lead per free rep, so
 * there's always a human waiting — zero abandonment. A ratio > 1 dials ahead to
 * cut rep idle time; the AI-holds-the-line design keeps that from abandoning
 * because a lead who answers with no rep free is engaged by the AI, not dropped.
 *
 * We subtract calls already in flight (ringing / on a hold) so a burst ratio
 * doesn't stack every tick into an ever-growing pile of held callers.
 */
export function computeDialBatchSize(params: {
  availableReps: number
  dialRatio: number
  inFlightCalls: number
  /** Optional hard ceiling per tick (e.g. org calls/hour budget slice). */
  maxThisTick?: number
}): number {
  const { availableReps, dialRatio, inFlightCalls, maxThisTick } = params
  if (availableReps <= 0) return 0

  const target = Math.floor(availableReps * Math.max(dialRatio, 0))
  let batch = Math.max(target - inFlightCalls, 0)
  if (typeof maxThisTick === 'number') batch = Math.min(batch, Math.max(maxThisTick, 0))
  return batch
}
