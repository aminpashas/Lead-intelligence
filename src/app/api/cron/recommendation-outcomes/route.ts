import { withCron } from '@/lib/cron/with-cron'
import { applySmartListCriteria } from '@/lib/campaigns/smart-list-resolver'
import type { SmartListCriteria } from '@/types/database'

/**
 * POST /api/cron/recommendation-outcomes — daily.
 *
 * The measurement half of the C2 feedback loop: for every acted-on
 * recommendation (applied OR dismissed — dismissed rows are the control group)
 * that is ≥ 30 days past acted_at and not yet measured, compute
 *
 *   outcome = {
 *     conversions_30d: leads matching the segment that converted within
 *                      (acted_at, acted_at + 30d],
 *     revenue_30d:     Σ actual_revenue over those conversions,
 *   }
 *
 * MEASUREMENT METHOD (pragmatic, documented): lead ids are NOT snapshotted at
 * apply time (the apply route only count-resolves the segment), so the segment
 * is RE-RESOLVED from stored criteria at measurement time — with the
 * time-relative recency filters stripped (last_contacted_before,
 * never_contacted, closing_follow_up_before). Left in place those filters
 * would exclude precisely the leads that were acted on (they got contacted),
 * biasing conversions toward zero. Stage/qualification/intent filters are
 * kept; a lead that moved stages after the action falls out of the measured
 * set — an accepted approximation, flagged in outcome.method. Queries stay
 * bounded: one head-count + one capped revenue fetch per row, ≤ ROWS_PER_RUN
 * rows per night.
 */

export const maxDuration = 300

const MEASURE_AFTER_DAYS = 30
const ROWS_PER_RUN = 100
/** Revenue fetch cap — conversions inside one segment/month never realistically
 *  approach this; if they do, revenue_30d is a floor and the outcome says so. */
const REVENUE_ROWS_CAP = 2000

/** Time-relative criteria that would bias a 30-day re-resolution. */
const RECENCY_KEYS = ['last_contacted_before', 'never_contacted', 'closing_follow_up_before'] as const

function stripRecencyFilters(criteria: SmartListCriteria): {
  stripped: SmartListCriteria
  removed: string[]
} {
  const clone: Record<string, unknown> = { ...criteria }
  const removed: string[] = []
  for (const key of RECENCY_KEYS) {
    if (key in clone) {
      delete clone[key]
      removed.push(key)
    }
  }
  return { stripped: clone as SmartListCriteria, removed }
}

type DueRow = {
  id: string
  organization_id: string
  segment_criteria: SmartListCriteria
  acted_at: string
}

export const POST = withCron('recommendation-outcomes', async ({ supabase }) => {
  const nowMs = Date.now()
  const cutoffIso = new Date(nowMs - MEASURE_AFTER_DAYS * 86_400_000).toISOString()

  const { data: due, error: dueError } = await supabase
    .from('pipeline_recommendations')
    .select('id, organization_id, segment_criteria, acted_at')
    .in('status', ['applied', 'dismissed'])
    .is('outcome', null)
    .not('acted_at', 'is', null)
    .lt('acted_at', cutoffIso)
    .order('acted_at', { ascending: true })
    .limit(ROWS_PER_RUN)
  if (dueError) throw new Error(`due recommendations fetch failed: ${dueError.message}`)

  if (!due || due.length === 0) {
    return { status: 'ok', items: 0, data: { measured: 0, message: 'Nothing due' } }
  }

  let measured = 0
  const errors: string[] = []

  for (const row of due as DueRow[]) {
    try {
      const { stripped, removed } = stripRecencyFilters(row.segment_criteria ?? {})
      const windowEndIso = new Date(
        new Date(row.acted_at).getTime() + MEASURE_AFTER_DAYS * 86_400_000
      ).toISOString()

      // Conversions in the segment within 30 days of the action (exact count).
      let countQ = supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', row.organization_id)
        .gt('converted_at', row.acted_at)
        .lte('converted_at', windowEndIso)
      countQ = applySmartListCriteria(countQ, stripped)
      const { count, error: countError } = await countQ
      if (countError) throw new Error(countError.message)
      const conversions = count ?? 0

      // Revenue over the same conversions (bounded row fetch).
      let revenue = 0
      let revenueCapped = false
      if (conversions > 0) {
        let revQ = supabase
          .from('leads')
          .select('actual_revenue')
          .eq('organization_id', row.organization_id)
          .gt('converted_at', row.acted_at)
          .lte('converted_at', windowEndIso)
          .not('actual_revenue', 'is', null)
        revQ = applySmartListCriteria(revQ, stripped)
        const { data: revRows, error: revError } = await revQ.limit(REVENUE_ROWS_CAP)
        if (revError) throw new Error(revError.message)
        revenue = (revRows ?? []).reduce(
          (sum: number, r: { actual_revenue: number | string | null }) =>
            sum + (Number(r.actual_revenue) || 0),
          0
        )
        revenueCapped = (revRows ?? []).length >= REVENUE_ROWS_CAP
      }

      const { error: updateError } = await supabase
        .from('pipeline_recommendations')
        .update({
          outcome: {
            conversions_30d: conversions,
            revenue_30d: Math.round(revenue * 100) / 100,
            method: 'criteria_re_resolution',
            recency_filters_stripped: removed,
            revenue_capped: revenueCapped,
            window_end: windowEndIso,
          },
          outcome_measured_at: new Date(nowMs).toISOString(),
        })
        .eq('id', row.id)
      if (updateError) throw new Error(updateError.message)
      measured++
    } catch (err) {
      errors.push(
        `${row.id}: ${err instanceof Error ? err.message : 'outcome measurement failed'}`
      )
    }
  }

  return {
    status: errors.length > 0 && measured === 0 ? 'failed' : 'ok',
    items: measured,
    data: { due: due.length, measured, errors },
  }
})

export const GET = POST
