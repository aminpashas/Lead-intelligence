/**
 * Daily ops digest — surfaces silent failures across the delivery pipelines.
 *
 * Does not mutate app data. Counts, over the last 24h where time-bounded:
 *   - events with capi_status='failed' or gads_status='failed'
 *   - growth_studio_outbox rows that are failed/unknown (writeback never confirmed
 *     delivered), or stuck pending >2h (emitted but never reconciled)
 *   - open escalations (status in 'pending'/'claimed')
 *   - unhealthy crons (stale heartbeat or last run failed) via cron_runs
 *
 * If anything is non-zero it emits a Sentry warning + structured console line,
 * posts a best-effort Slack alert (when SLACK_WEBHOOK_URL is set), and returns
 * the counts as JSON.
 *
 * Schedule: once daily (vercel.json).
 */

import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { createServiceClient } from '@/lib/supabase/server'
import { getCronHealth, type CronHealthIssue } from '@/lib/cron/with-cron'

/**
 * Best-effort Slack alert to the global SLACK_WEBHOOK_URL incoming webhook.
 * No-op when the env is unset; never throws.
 */
async function postSlackAlert(
  total: number,
  counts: Record<string, number>,
  cronIssues: CronHealthIssue[]
): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL
  if (!url) return
  const lines = [
    `:rotating_light: *Lead Intelligence ops-digest* — ${total} issue(s) need attention`,
    `• CAPI failed (24h): ${counts.capi_failed_24h}`,
    `• Google Ads failed (24h): ${counts.gads_failed_24h}`,
    `• DGS writeback failed/unknown: ${counts.outbox_failed}`,
    `• DGS writeback stuck (>2h pending): ${counts.outbox_stuck_pending}`,
    `• Open escalations: ${counts.open_escalations}`,
    `• Link-lender apps awaiting outcome (>7d): ${counts.link_sent_stale}`,
    `• Agents in probation: ${counts.agents_in_probation}`,
    `• Unhealthy crons: ${counts.unhealthy_crons}`,
  ]
  for (const c of cronIssues) {
    lines.push(`    – ${c.cron}: ${c.issue}${c.error ? ` (${c.error})` : ''}`)
  }
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: lines.join('\n') }),
      signal: AbortSignal.timeout(5000),
    })
  } catch (err) {
    console.warn('[ops-digest] slack alert failed', err)
  }
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // Helper: head-only count query returns { count }. We default to 0 on error so
  // a single failing count never blocks the rest of the digest.
  const countOf = async (
    q: Promise<{ count: number | null; error: unknown }>
  ): Promise<number> => {
    const { count, error } = await q
    if (error) return 0
    return count ?? 0
  }

  // A writeback that never confirmed delivery: terminal failed/unknown, OR stuck
  // pending past this cutoff (emitted but reconcile never resolved it).
  const stuckBefore = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  // A link-lender application sat at 'link_sent' for over a week with no recorded
  // outcome — the honest-link path's silent failure (revenue signal never closed).
  const linkStaleBefore = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [
    capiFailed,
    gadsFailed,
    outboxFailed,
    outboxStuckPending,
    openEscalations,
    linkSentStale,
    agentsProbation,
  ] = await Promise.all([
      countOf(
        supabase
          .from('events')
          .select('id', { count: 'exact', head: true })
          .eq('capi_status', 'failed')
          .gte('occurred_at', since)
      ),
      countOf(
        supabase
          .from('events')
          .select('id', { count: 'exact', head: true })
          .eq('gads_status', 'failed')
          .gte('occurred_at', since)
      ),
      countOf(
        supabase
          .from('growth_studio_outbox')
          .select('id', { count: 'exact', head: true })
          .in('status', ['failed', 'unknown'])
      ),
      countOf(
        supabase
          .from('growth_studio_outbox')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending')
          .lt('created_at', stuckBefore)
      ),
      countOf(
        supabase
          .from('escalations')
          .select('id', { count: 'exact', head: true })
          .in('status', ['pending', 'claimed'])
      ),
      countOf(
        supabase
          .from('financing_submissions')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'link_sent')
          .lt('responded_at', linkStaleBefore)
      ),
      // Business-outcome signal: agents the KPI engine put on probation.
      countOf(
        supabase
          .from('agent_status_current')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'probation')
      ),
    ])

  // Cron heartbeat health — a stale or failing cron is a silent failure the
  // failure counts above can't surface (a dead cron emits nothing at all).
  const cronIssues = await getCronHealth(supabase)

  const counts = {
    capi_failed_24h: capiFailed,
    gads_failed_24h: gadsFailed,
    outbox_failed: outboxFailed,
    outbox_stuck_pending: outboxStuckPending,
    open_escalations: openEscalations,
    link_sent_stale: linkSentStale,
    agents_in_probation: agentsProbation,
    unhealthy_crons: cronIssues.length,
  }

  const total =
    capiFailed +
    gadsFailed +
    outboxFailed +
    outboxStuckPending +
    openEscalations +
    linkSentStale +
    agentsProbation +
    cronIssues.length

  if (total > 0) {
    const detail = { ...counts, cron_issues: cronIssues }
    console.warn(
      `[ops-digest] ${total} issues need attention`,
      JSON.stringify(detail)
    )
    Sentry.captureMessage(`ops-digest: ${total} issues need attention`, {
      level: 'warning',
      extra: detail,
    })
    await postSlackAlert(total, counts, cronIssues)
  }

  return NextResponse.json({ total, ...counts, cron_issues: cronIssues })
}

export const GET = POST
