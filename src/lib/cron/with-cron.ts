/**
 * Cron wrapper + heartbeat observability.
 *
 * `withCron(name, handler)` centralizes the CRON_SECRET auth guard that every
 * cron route duplicated, provisions a service-role Supabase client, records a
 * `cron_runs` heartbeat on every outcome (including thrown failures), and reports
 * to Sentry on throw. The handler returns a CronOutcome; its `data` becomes the
 * JSON response body so each cron's existing response shape is preserved.
 *
 * Why this exists: a cron returning 200 is not proof it did work. The heartbeat
 * lets `getCronHealth()` (consumed by the ops-digest cron) detect a cron that has
 * silently stopped running or whose last run failed.
 */

import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { createServiceClient } from '@/lib/supabase/server'

type ServiceClient = ReturnType<typeof createServiceClient>

export type CronOutcome = {
  /**
   * 'ok'      — ran and did work (items may be 0, which is logged, not assumed healthy)
   * 'skipped' — healthy no-op (e.g. no connector configured)
   * 'failed'  — soft failure the handler wants recorded without throwing
   * Defaults to 'ok'.
   */
  status?: 'ok' | 'skipped' | 'failed'
  /** Items processed this run. Recorded for observability; 0 is fine. */
  items?: number
  /** Response body returned to the caller — preserves each cron's existing shape. */
  data?: Record<string, unknown>
}

type CronContext = { request: NextRequest; supabase: ServiceClient }

/**
 * Records a single cron heartbeat. Best-effort: never throws, so an observability
 * write can't break the cron it is observing.
 */
export async function recordCronRun(
  supabase: ServiceClient,
  cron: string,
  fields: { status: 'ok' | 'skipped' | 'failed'; items?: number; durationMs?: number; error?: string }
): Promise<void> {
  try {
    await supabase.from('cron_runs').insert({
      cron,
      status: fields.status,
      items_processed: fields.items ?? 0,
      duration_ms: fields.durationMs ?? null,
      error: fields.error ?? null,
    })
  } catch (err) {
    console.warn(`[cron] failed to record heartbeat for ${cron}`, err)
  }
}

export function withCron(
  cron: string,
  handler: (ctx: CronContext) => Promise<CronOutcome>
): (request: NextRequest) => Promise<NextResponse> {
  return async function (request: NextRequest): Promise<NextResponse> {
    const authHeader = request.headers.get('authorization')
    if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = createServiceClient()
    const started = Date.now()

    try {
      const outcome = await handler({ request, supabase })
      const status = outcome.status ?? 'ok'
      await recordCronRun(supabase, cron, {
        status,
        items: outcome.items,
        durationMs: Date.now() - started,
      })
      return NextResponse.json({ cron, status, ...(outcome.data ?? {}) })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'cron handler threw'
      await recordCronRun(supabase, cron, {
        status: 'failed',
        durationMs: Date.now() - started,
        error: message,
      })
      Sentry.captureException(err, { tags: { cron } })
      console.error(`[cron:${cron}] failed`, err)
      return NextResponse.json({ cron, error: 'cron_failed' }, { status: 500 })
    }
  }
}

/**
 * Crons we expect to heartbeat, with the max age (minutes) before a missing run is
 * considered stale — derived from the vercel.json schedule plus a generous grace
 * window. Only list a cron here once it adopts withCron(); unlisted crons are not
 * health-checked so they cannot false-alarm before instrumentation.
 */
export const EXPECTED_CRONS: Record<string, number> = {
  'reconcile-growth-studio-outbox': 40, // every 10 min
  'a2p-status': 8 * 60, // every 6h + grace
  'reengagement': 90, // hourly + grace
  'carestack-sync': 26 * 60, // daily 04:30 UTC
  'windsor-sync': 26 * 60, // daily 05:00 UTC
  'brex-sync': 26 * 60, // daily 06:00 UTC
  disqualify: 26 * 60, // daily 08:00 UTC
}

export type CronHealthIssue = {
  cron: string
  issue: 'stale' | 'failing'
  last_ran_at: string | null
  last_status: string | null
  error: string | null
}

/**
 * Returns unhealthy crons: stale (no heartbeat within the expected window) or whose
 * most recent run failed. Read-only. A cron with no rows yet is intentionally NOT
 * reported (expected immediately after deploy, before its first scheduled run).
 */
export async function getCronHealth(supabase: ServiceClient): Promise<CronHealthIssue[]> {
  const issues: CronHealthIssue[] = []
  const now = Date.now()

  for (const [cron, maxStaleMin] of Object.entries(EXPECTED_CRONS)) {
    const { data } = await supabase
      .from('cron_runs')
      .select('status, error, ran_at')
      .eq('cron', cron)
      .order('ran_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!data) continue // never run yet — not an alertable state

    if (data.status === 'failed') {
      issues.push({
        cron,
        issue: 'failing',
        last_ran_at: data.ran_at,
        last_status: data.status,
        error: data.error,
      })
      continue
    }

    const ageMin = (now - new Date(data.ran_at).getTime()) / 60000
    if (ageMin > maxStaleMin) {
      issues.push({
        cron,
        issue: 'stale',
        last_ran_at: data.ran_at,
        last_status: data.status,
        error: null,
      })
    }
  }

  return issues
}
