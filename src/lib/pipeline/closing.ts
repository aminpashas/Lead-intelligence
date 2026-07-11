import type { Lead } from '@/types/database'

/**
 * "In Closing" workflow helpers — the logic behind the /closing board.
 *
 * A deal is "in closing" once a treatment has been presented and we're working
 * the money (financing / down payment). That's the same population the Stalled
 * Deals nurture cohort targets — this board is the human-driven front door to it.
 *
 * Pure + `nowMs`-injected so it unit-tests without mocks, matching the sibling
 * `close-probability.ts` module it builds on.
 */

/** Pipeline stage slugs that count as "in closing" (owner decision 2026-07-04). */
export const CLOSING_STAGE_SLUGS = ['treatment-presented', 'financing'] as const

/** A deal goes "stalled" once it has had no contact for this many days. */
export const CLOSING_STALE_DAYS = 21

/**
 * Closing temperatures.
 *
 * `hot | warm | cold` track close probability; `stalled` is DERIVED from silence
 * (see `deriveClosingTemperature`). `deliberating` is MANUAL-ONLY — a closer sets
 * it when a patient who has seen the plan is actively deciding ("let me think /
 * talk to my spouse / save up"). It is engaged-and-waiting, distinct from
 * `stalled` (gone quiet) and from Lost (dead). It is never auto-derived; it only
 * appears as a human override, paired with `leads.closing_follow_up_at`.
 */
export type ClosingTemperature = 'hot' | 'warm' | 'cold' | 'stalled' | 'deliberating'

/** Whole days since `dateStr` (null if never contacted). */
export function daysSince(dateStr: string | null, nowMs: number): number | null {
  if (!dateStr) return null
  return Math.floor((nowMs - new Date(dateStr).getTime()) / 86_400_000)
}

/**
 * Derived closing temperature — the DEFAULT shown when a human hasn't set a
 * manual override (`leads.closing_temperature`). Encodes how a deal in closing
 * should be triaged: a deal that's gone quiet is "stalled" no matter how strong
 * it looked; otherwise temperature tracks the AI close probability.
 *
 * The spreadsheet used gut feel ("maybe / cold / super cold"). This grounds it
 * in two signals we actually track: close probability and days since contact.
 *
 * @param closeProbability 0–1 from scoreCloseProbability()
 * @param daysSinceContact whole days since last contact, or null if never
 */
export function deriveClosingTemperature(
  closeProbability: number,
  daysSinceContact: number | null
): ClosingTemperature {
  if (daysSinceContact !== null && daysSinceContact > CLOSING_STALE_DAYS) return 'stalled'
  if (closeProbability >= 0.5) return 'hot'
  if (closeProbability >= 0.25) return 'warm'
  return 'cold'
}

/** Manual override wins; otherwise fall back to the derived temperature. */
export function effectiveTemperature(
  manual: Lead['closing_temperature'],
  closeProbability: number,
  daysSinceContact: number | null
): ClosingTemperature {
  return (manual as ClosingTemperature | null) ?? deriveClosingTemperature(closeProbability, daysSinceContact)
}

/**
 * Where a deal sits in the closer's live queue:
 *
 *   - `waiting` — deliberating with a follow-up date still in the future. The
 *     closer agreed to circle back later; muted / hidden from the live queue
 *     until its timer fires. This is what keeps "thinking about it" deals from
 *     cluttering the working column.
 *   - `due`     — deliberating and the follow-up date has arrived (or a
 *     deliberating deal with NO date set — treat as due, don't lose it).
 *     Surfaces for the nudge.
 *   - `active`  — everything else: untouched deals and normal working deals.
 *     Always in the live queue.
 *
 * The live queue is `active` + `due`; `waiting` is collapsed. Pure (now injected)
 * so it unit-tests without mocks, matching the rest of this module.
 */
export type ClosingQueueState = 'active' | 'due' | 'waiting'

export function closingQueueState(
  temperature: Lead['closing_temperature'],
  followUpAt: string | null,
  nowMs: number
): ClosingQueueState {
  if (temperature !== 'deliberating') return 'active'
  // Deliberating but no timer set: keep it visible rather than silently hiding it.
  if (!followUpAt) return 'due'
  return new Date(followUpAt).getTime() <= nowMs ? 'due' : 'waiting'
}

/** True when a deal belongs in the closer's live queue (not muted as waiting). */
export function isInLiveQueue(
  temperature: Lead['closing_temperature'],
  followUpAt: string | null,
  nowMs: number
): boolean {
  return closingQueueState(temperature, followUpAt, nowMs) !== 'waiting'
}

export type ClosingDeal = { treatmentValue: number | null; closeProbability: number; daysSinceContact: number | null }

/**
 * Roll a set of in-closing deals into the header numbers the spreadsheet could
 * never compute: gross case value on the table, and the probability-WEIGHTED
 * forecast (Σ value × close-probability) — what's actually likely to close.
 */
export function closingForecast(deals: ClosingDeal[]) {
  let totalValue = 0
  let weightedValue = 0
  let contactedDays = 0
  let contactedCount = 0
  for (const d of deals) {
    const v = d.treatmentValue ?? 0
    totalValue += v
    weightedValue += v * d.closeProbability
    if (d.daysSinceContact !== null) {
      contactedDays += d.daysSinceContact
      contactedCount += 1
    }
  }
  return {
    count: deals.length,
    totalValue,
    weightedValue: Math.round(weightedValue),
    avgDaysSinceContact: contactedCount ? Math.round(contactedDays / contactedCount) : null,
  }
}
