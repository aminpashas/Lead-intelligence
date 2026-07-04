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

export type ClosingTemperature = 'hot' | 'warm' | 'cold' | 'stalled'

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
