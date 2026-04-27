/**
 * Agent grading: turns per-KPI values + targets into an overall grade.
 *
 * Single source of truth — used by the weekly review cron to write
 * agent_performance_reviews rows AND by the UI to render the status
 * pill on the scorecard. Keep this module pure (no I/O) so both
 * server-side cron and client-side display stay in lockstep.
 *
 * Phase B of the AI Agent KPI Dashboard system.
 */

import {
  computeKpiStatus,
  KPI_DISPLAY_ORDER,
  DISPLAY_ONLY_KPIS,
  type KpiTarget,
  type KpiStatus,
} from './kpi-status'

export type AgentGrade = 'green' | 'yellow' | 'red' | 'probation' | 'unrated'

export type KpiScore = {
  kpi_name: string
  value: number | null
  target: number | null
  status: 'pass' | 'warning' | 'critical' | 'no_target'
}

export type GradeReason = {
  kpi_name: string
  severity: 'warning' | 'critical'
  value: number | null
  target: number | null
}

export type GradeResult = {
  grade: AgentGrade
  scores: KpiScore[]
  reasons: GradeReason[]
  /** How many KPIs were measurable this period (excludes display-only and missing-target). */
  rated_kpis: number
}

/**
 * Convert a `KpiStatus` (UI green/yellow/red) into the grading
 * `pass/warning/critical` enum stored in `kpi_scores.status`.
 */
function toScoreStatus(s: KpiStatus): KpiScore['status'] {
  switch (s) {
    case 'green':
      return 'pass'
    case 'yellow':
      return 'warning'
    case 'red':
      return 'critical'
    default:
      return 'no_target'
  }
}

/**
 * Grade one agent for one period.
 *
 * Rules:
 *   - red       = ≥2 critical KPIs OR ≥4 warnings
 *   - yellow    = 1 critical KPI OR 2-3 warnings
 *   - green     = 0 critical AND ≤1 warning
 *   - unrated   = no measurable KPIs (no agent activity that period)
 *   - probation is set by the cron (consecutive_red_periods ≥ 2),
 *     not by this function — keep this pure.
 *
 * Display-only KPIs (closed_revenue, cac_per_converted) are skipped:
 * they're informational, not graded.
 */
export function gradeAgent(
  kpiValues: Record<string, number | null | undefined>,
  targets: Map<string, KpiTarget>
): GradeResult {
  const scores: KpiScore[] = []
  const reasons: GradeReason[] = []
  let critical = 0
  let warning = 0
  let rated = 0

  for (const kpiName of KPI_DISPLAY_ORDER) {
    if (DISPLAY_ONLY_KPIS.has(kpiName)) continue

    const rawValue = kpiValues[kpiName]
    const value = rawValue === null || rawValue === undefined ? null : Number(rawValue)
    const target = targets.get(kpiName) ?? null
    const status = computeKpiStatus(value, target)

    scores.push({
      kpi_name: kpiName,
      value,
      target: target?.target_value ?? null,
      status: toScoreStatus(status),
    })

    if (status === 'red') {
      critical++
      reasons.push({
        kpi_name: kpiName,
        severity: 'critical',
        value,
        target: target?.target_value ?? null,
      })
    } else if (status === 'yellow') {
      warning++
      reasons.push({
        kpi_name: kpiName,
        severity: 'warning',
        value,
        target: target?.target_value ?? null,
      })
    }

    if (status !== 'no_target') rated++
  }

  let grade: AgentGrade
  if (rated === 0) {
    grade = 'unrated'
  } else if (critical >= 2 || warning >= 4) {
    grade = 'red'
  } else if (critical >= 1 || warning >= 2) {
    grade = 'yellow'
  } else {
    grade = 'green'
  }

  return { grade, scores, reasons, rated_kpis: rated }
}

/**
 * Decide the next status given a freshly-computed grade and the
 * current consecutive_red_periods counter. Returns the status to
 * persist in agent_status_current.
 *
 * Two consecutive red periods → probation. Probation only clears
 * after a non-red review.
 */
export function nextStatusAfterReview(
  newGrade: AgentGrade,
  consecutiveRed: number
): { status: AgentGrade; consecutive_red_periods: number; consecutive_green_periods_delta: number } {
  if (newGrade === 'red') {
    const nextRed = consecutiveRed + 1
    return {
      status: nextRed >= 2 ? 'probation' : 'red',
      consecutive_red_periods: nextRed,
      consecutive_green_periods_delta: 0,
    }
  }

  if (newGrade === 'green') {
    return {
      status: 'green',
      consecutive_red_periods: 0,
      consecutive_green_periods_delta: 1,
    }
  }

  // yellow or unrated: reset the red streak but don't bank a green
  return {
    status: newGrade,
    consecutive_red_periods: 0,
    consecutive_green_periods_delta: 0,
  }
}

export const STATUS_LABELS: Record<AgentGrade, string> = {
  green: 'On track',
  yellow: 'Watch',
  red: 'Below target',
  probation: 'Probation',
  unrated: 'Unrated',
}

export const STATUS_DESCRIPTIONS: Record<AgentGrade, string> = {
  green: 'Hitting all targets — no critical KPI misses, at most one warning.',
  yellow: 'Partial misses — at least one critical or two warnings. Course-correct.',
  red: 'Multiple critical misses. Adjust outreach protocol.',
  probation: 'Two consecutive red periods. Auto-discipline action triggered.',
  unrated: 'Not enough activity in the period to grade.',
}
