/**
 * Org goal pacing (Phase 5). Pure "are we on pace?" math, reusing the same
 * green/yellow/red language as the agent KPI grading so the dashboard reads
 * consistently. Compares attainment (actual/target) against time elapsed in the
 * goal period.
 */

export type GoalMetric =
  | 'pipeline_value'
  | 'conversions'
  | 'revenue'
  | 'bookings'
  | 'qualification_rate'

export type PaceStatus = 'green' | 'yellow' | 'red' | 'no_data'

export interface GoalProgress {
  /** actual / target, as a percentage. */
  pct: number
  /** fraction of the period elapsed, as a percentage. */
  expectedPct: number
  paceStatus: PaceStatus
  onPace: boolean
}

function clamp01(n: number): number {
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

export function computeGoalProgress(p: {
  target: number
  actual: number
  periodStart: string
  periodEnd: string
  now?: string
}): GoalProgress {
  if (!(p.target > 0)) {
    return { pct: 0, expectedPct: 0, paceStatus: 'no_data', onPace: false }
  }

  const start = new Date(p.periodStart).getTime()
  const end = new Date(p.periodEnd).getTime()
  const now = p.now ? new Date(p.now).getTime() : Date.now()

  const span = end - start
  const elapsedFrac = span > 0 ? clamp01((now - start) / span) : now >= end ? 1 : 0

  const pct = (p.actual / p.target) * 100
  const expectedPct = elapsedFrac * 100

  // Before the period starts there's nothing to be behind on.
  if (elapsedFrac === 0) {
    return { pct, expectedPct, paceStatus: 'green', onPace: true }
  }

  const attainmentRatio = p.actual / p.target / elapsedFrac
  const paceStatus: PaceStatus =
    attainmentRatio >= 1 ? 'green' : attainmentRatio >= 0.8 ? 'yellow' : 'red'

  return { pct, expectedPct, paceStatus, onPace: attainmentRatio >= 1 }
}
