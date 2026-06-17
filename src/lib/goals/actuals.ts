/**
 * Compute the current "actual" for an org goal metric from lead rows (Phase 5).
 * Pure + testable; the progress endpoint feeds it leads and a period.
 */

import type { GoalMetric } from './pacing'

export interface ActualLead {
  status: string | null
  ai_qualification: string | null
  treatment_value: number | null
  actual_revenue: number | null
  created_at: string | null
  converted_at: string | null
  consultation_date: string | null
}

const DEAD_STATUSES = new Set(['lost', 'disqualified'])

function inPeriod(date: string | null, start: number, end: number): boolean {
  if (!date) return false
  const t = new Date(date).getTime()
  return t >= start && t <= end
}

export function actualForMetric(
  leads: ActualLead[],
  metric: GoalMetric,
  periodStart: string,
  periodEnd: string
): number {
  const start = new Date(periodStart).getTime()
  const end = new Date(periodEnd).getTime()

  switch (metric) {
    case 'pipeline_value':
      // Snapshot of open + won pipeline value (not period-bound).
      return leads
        .filter((l) => !DEAD_STATUSES.has(l.status ?? ''))
        .reduce((s, l) => s + (l.treatment_value ?? 0), 0)

    case 'conversions':
      return leads.filter((l) => inPeriod(l.converted_at, start, end)).length

    case 'revenue':
      return leads
        .filter((l) => inPeriod(l.converted_at, start, end))
        .reduce((s, l) => s + (l.actual_revenue ?? 0), 0)

    case 'bookings':
      return leads.filter((l) => inPeriod(l.consultation_date, start, end)).length

    case 'qualification_rate': {
      const created = leads.filter((l) => inPeriod(l.created_at, start, end))
      if (created.length === 0) return 0
      const qualified = created.filter(
        (l) => l.ai_qualification != null && l.ai_qualification !== 'unqualified'
      ).length
      return (qualified / created.length) * 100
    }
  }
}
