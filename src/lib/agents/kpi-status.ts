/**
 * KPI status + formatting helpers shared by API and UI.
 *
 * Keep all threshold math here so API responses and client-side
 * renders never disagree on whether a KPI is green/yellow/red.
 */

export type KpiDirection = 'higher_is_better' | 'lower_is_better'
export type KpiStatus = 'green' | 'yellow' | 'red' | 'no_target'

export type KpiTarget = {
  kpi_name: string
  target_value: number
  warning_threshold: number
  critical_threshold: number
  direction: KpiDirection
}

export type KpiResult = {
  value: number | null
  target: number | null
  warning: number | null
  critical: number | null
  direction: KpiDirection | null
  status: KpiStatus
}

/**
 * Green: meets or beats target.
 * Yellow: between warning_threshold and target (within striking distance).
 * Red: past critical_threshold.
 *
 * For higher_is_better: green when value ≥ target; yellow when ≥ warning;
 *   red when value ≤ critical. Between warning and critical → yellow.
 * For lower_is_better: green when value ≤ target; yellow when ≤ warning;
 *   red when value ≥ critical.
 *
 * Returns 'no_target' when target is missing (defensive — the migration
 * seeds defaults so this should be rare).
 */
export function computeKpiStatus(
  value: number | null | undefined,
  target: KpiTarget | null | undefined
): KpiStatus {
  if (value === null || value === undefined) return 'no_target'
  if (!target) return 'no_target'

  if (target.direction === 'higher_is_better') {
    if (value >= target.target_value) return 'green'
    if (value <= target.critical_threshold) return 'red'
    if (value >= target.warning_threshold) return 'yellow'
    return 'red'
  } else {
    if (value <= target.target_value) return 'green'
    if (value >= target.critical_threshold) return 'red'
    if (value <= target.warning_threshold) return 'yellow'
    return 'red'
  }
}

/** Human-readable KPI labels for the UI. */
export const KPI_LABELS: Record<string, string> = {
  contact_rate: 'Contact Rate',
  avg_call_rating: 'Avg Call Rating',
  booking_rate: 'Booking Rate',
  no_show_rate: 'No-Show Rate',
  reschedule_rate: 'Reschedule Rate',
  qualification_rate: 'Qualification Rate',
  follow_up_rate: 'Follow-Up Rate',
  leads_went_cold_rate: 'Leads Went Cold',
  no_communication_rate: 'No Communication',
  avg_response_minutes: 'Avg Response Time',
  closed_revenue: 'Closed Revenue',
  cac_per_converted: 'CAC per Converted',
}

export const KPI_DESCRIPTIONS: Record<string, string> = {
  contact_rate: 'Share of outreach-attempted leads that replied at least once.',
  avg_call_rating: 'Average admin QA rating across this agent\'s conversations.',
  booking_rate: 'Share of attributed leads that booked a consultation.',
  no_show_rate: 'Share of completed-or-no-showed appointments that no-showed.',
  reschedule_rate: 'Share of all appointment outcomes that were reschedules.',
  qualification_rate: 'Share of attributed leads that reached qualified status.',
  follow_up_rate: 'Of unresponded leads, the share that received a second attempt.',
  leads_went_cold_rate: 'Share of attributed leads with no contact for 14+ days and still active.',
  no_communication_rate: 'Share of attributed leads that never sent a single reply.',
  avg_response_minutes: 'Average minutes between an inbound message and the agent\'s reply.',
  closed_revenue: 'Revenue collected from this agent\'s attributed leads in the window.',
  cac_per_converted: 'AI cost divided by converted leads — an AI-only CAC proxy.',
}

/** Units / formatting hints for KPI display. */
export type KpiUnit = 'percent' | 'rating' | 'minutes' | 'currency'

export const KPI_UNITS: Record<string, KpiUnit> = {
  contact_rate: 'percent',
  avg_call_rating: 'rating',
  booking_rate: 'percent',
  no_show_rate: 'percent',
  reschedule_rate: 'percent',
  qualification_rate: 'percent',
  follow_up_rate: 'percent',
  leads_went_cold_rate: 'percent',
  no_communication_rate: 'percent',
  avg_response_minutes: 'minutes',
  closed_revenue: 'currency',
  cac_per_converted: 'currency',
}

/** Human-friendly formatting for a KPI value. */
export function formatKpiValue(value: number | null | undefined, unit: KpiUnit): string {
  if (value === null || value === undefined) return '—'
  switch (unit) {
    case 'percent':
      return `${value.toFixed(1)}%`
    case 'rating':
      return value.toFixed(2)
    case 'minutes':
      return value >= 60
        ? `${(value / 60).toFixed(1)}h`
        : `${value.toFixed(1)}m`
    case 'currency':
      return value >= 1000
        ? `$${(value / 1000).toFixed(1)}k`
        : `$${value.toFixed(0)}`
  }
}

/** Arrow indicator — up means the direction of "good". */
export function kpiDirectionArrow(direction: KpiDirection | null): '↑' | '↓' | '' {
  if (direction === 'higher_is_better') return '↑'
  if (direction === 'lower_is_better') return '↓'
  return ''
}

/** The canonical ordered list of KPIs to render in the scorecard. */
export const KPI_DISPLAY_ORDER: string[] = [
  'contact_rate',
  'booking_rate',
  'qualification_rate',
  'follow_up_rate',
  'no_show_rate',
  'reschedule_rate',
  'leads_went_cold_rate',
  'no_communication_rate',
  'avg_call_rating',
  'avg_response_minutes',
  'closed_revenue',
  'cac_per_converted',
]

/** KPIs that have no seeded target (display-only). */
export const DISPLAY_ONLY_KPIS = new Set<string>(['closed_revenue', 'cac_per_converted'])
