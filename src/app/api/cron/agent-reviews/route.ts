import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { gradeAgent, nextStatusAfterReview, STATUS_LABELS } from '@/lib/agents/grading'
import { runDisciplineEngine } from '@/lib/agents/discipline-engine'
import type { KpiTarget } from '@/lib/agents/kpi-status'
import { logger } from '@/lib/logger'

// POST /api/cron/agent-reviews — Weekly cron (Mon 03:00 UTC)
//
// For every active agent in every org:
//   1. Pull last 7 days of KPI values via get_agent_kpi_summary RPC.
//   2. Grade against agent_kpi_targets using gradeAgent() (same math
//      the UI uses — single source of truth).
//   3. Upsert agent_performance_reviews for the period.
//   4. Upsert agent_status_current with the new grade and updated
//      consecutive_red / consecutive_green counters.
//
// Discipline / reward actions (Phase C) layer on top of this — they
// read agent_status_current.consecutive_red_periods and act when the
// grade hits 'probation'.
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const supabase = createServiceClient()

  // Period: last 7 days, ending yesterday (so we don't grade
  // a partial day). Monday cron at 03:00 UTC sees Mon 00:00 → going
  // back 7 days lands cleanly on the prior Monday.
  const periodEnd = new Date()
  periodEnd.setUTCHours(0, 0, 0, 0)
  periodEnd.setUTCDate(periodEnd.getUTCDate() - 1)
  const periodStart = new Date(periodEnd)
  periodStart.setUTCDate(periodStart.getUTCDate() - 6)

  const periodStartIso = periodStart.toISOString()
  const periodEndIso = new Date(periodEnd.getTime() + 24 * 60 * 60 * 1000 - 1).toISOString()

  const { data: orgs, error: orgsErr } = await supabase
    .from('organizations')
    .select('id')

  if (orgsErr || !orgs) {
    return NextResponse.json({ error: orgsErr?.message ?? 'No organizations' }, { status: 500 })
  }

  const errors: string[] = []
  let reviewsWritten = 0
  let statusDrops = 0
  let probations = 0
  let disciplineActions = 0
  let protocolSwapsLive = 0
  let protocolSwapsProposed = 0

  for (const org of orgs) {
    try {
      // Fetch KPI values for all agents in the period
      const { data: kpiData, error: kpiErr } = await supabase.rpc('get_agent_kpi_summary', {
        p_org_id: org.id,
        p_start: periodStartIso,
        p_end: periodEndIso,
        p_agent_id: null,
      })

      if (kpiErr) {
        errors.push(`KPI fetch error (org ${org.id}): ${kpiErr.message}`)
        continue
      }

      const agents = (kpiData as Array<{
        id: string
        name: string
        role: string
        kpis: Record<string, number | null>
      }>) || []

      if (agents.length === 0) continue

      // Pull all targets for the org (one query, then group by agent)
      const { data: targetsRows, error: targetsErr } = await supabase
        .from('agent_kpi_targets')
        .select('agent_id, kpi_name, target_value, warning_threshold, critical_threshold, direction')
        .eq('organization_id', org.id)

      if (targetsErr) {
        errors.push(`Targets fetch error (org ${org.id}): ${targetsErr.message}`)
        continue
      }

      const targetsByAgent = new Map<string, Map<string, KpiTarget>>()
      for (const t of targetsRows || []) {
        const inner = targetsByAgent.get(t.agent_id) ?? new Map<string, KpiTarget>()
        inner.set(t.kpi_name, {
          kpi_name: t.kpi_name,
          target_value: Number(t.target_value),
          warning_threshold: Number(t.warning_threshold),
          critical_threshold: Number(t.critical_threshold),
          direction: t.direction,
        })
        targetsByAgent.set(t.agent_id, inner)
      }

      // Pull current status rows so we can read consecutive_red_periods
      const agentIds = agents.map((a) => a.id)
      const { data: statusRows } = await supabase
        .from('agent_status_current')
        .select('agent_id, status, consecutive_red_periods, consecutive_green_periods')
        .in('agent_id', agentIds)

      type StatusRow = {
        agent_id: string
        status: string
        consecutive_red_periods: number
        consecutive_green_periods: number
      }
      const statusByAgent = new Map<string, StatusRow>(
        ((statusRows ?? []) as StatusRow[]).map((r) => [r.agent_id, r])
      )

      const periodStartDate = periodStart.toISOString().slice(0, 10)
      const periodEndDate = periodEnd.toISOString().slice(0, 10)

      for (const agent of agents) {
        const targets = targetsByAgent.get(agent.id) ?? new Map<string, KpiTarget>()
        const result = gradeAgent(agent.kpis, targets)
        const prior = statusByAgent.get(agent.id)
        const priorRed = prior?.consecutive_red_periods ?? 0
        const priorGreen = prior?.consecutive_green_periods ?? 0
        const next = nextStatusAfterReview(result.grade, priorRed)

        // Upsert review row
        const { data: review, error: reviewErr } = await supabase
          .from('agent_performance_reviews')
          .upsert(
            {
              agent_id: agent.id,
              organization_id: org.id,
              period_start: periodStartDate,
              period_end: periodEndDate,
              kpi_scores: result.scores,
              overall_grade: next.status === 'probation' ? 'probation' : result.grade,
              reasons: result.reasons,
              reviewed_by: null,
              reviewed_at: new Date().toISOString(),
            },
            { onConflict: 'agent_id,period_start,period_end' }
          )
          .select('id, overall_grade')
          .single()

        if (reviewErr) {
          errors.push(`Review upsert error (agent ${agent.id}): ${reviewErr.message}`)
          continue
        }

        reviewsWritten++

        // Update current status
        const newStatus = next.status
        const statusChanged = (prior?.status ?? 'unrated') !== newStatus
        const droppedToWorse =
          (prior?.status === 'green' && newStatus !== 'green' && newStatus !== 'unrated') ||
          (prior?.status === 'yellow' && (newStatus === 'red' || newStatus === 'probation')) ||
          (prior?.status === 'red' && newStatus === 'probation')

        if (droppedToWorse) statusDrops++
        if (newStatus === 'probation') probations++

        await supabase.from('agent_status_current').upsert(
          {
            agent_id: agent.id,
            organization_id: org.id,
            status: newStatus,
            since: statusChanged ? new Date().toISOString() : (prior ? undefined : new Date().toISOString()),
            consecutive_red_periods: next.consecutive_red_periods,
            consecutive_green_periods: priorGreen + next.consecutive_green_periods_delta,
            last_review_id: review.id,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'agent_id' }
        )

        if (droppedToWorse) {
          logger.warn('Agent status drop', {
            agent_id: agent.id,
            agent_name: agent.name,
            from: prior?.status,
            to: newStatus,
            grade: result.grade,
            reasons: result.reasons.length,
            label: STATUS_LABELS[newStatus],
          })
        }
      }

      // After all reviews are written for this org, run reward/discipline.
      // Engine reads agent_status_current (just updated above) and adjusts
      // agent_lead_caps + audit-logs every action to agent_protocol_changes.
      try {
        const discResult = await runDisciplineEngine(supabase, org.id)
        disciplineActions += discResult.actions.length
        protocolSwapsLive += discResult.protocolSwapsLive
        protocolSwapsProposed += discResult.protocolSwapsProposed
      } catch (err) {
        errors.push(`Discipline engine error (org ${org.id}): ${err instanceof Error ? err.message : 'unknown'}`)
      }
    } catch (err) {
      errors.push(`Org loop error (${org.id}): ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }

  const summary = {
    success: true,
    period: { start: periodStart.toISOString().slice(0, 10), end: periodEnd.toISOString().slice(0, 10) },
    orgsProcessed: orgs.length,
    reviewsWritten,
    statusDrops,
    probations,
    disciplineActions,
    protocolSwapsLive,
    protocolSwapsProposed,
    errors: errors.length > 0 ? errors.slice(0, 20) : undefined,
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  }

  logger.info('Agent reviews cron completed', summary)
  return NextResponse.json(summary)
}

export async function GET(request: NextRequest) {
  return POST(request)
}
