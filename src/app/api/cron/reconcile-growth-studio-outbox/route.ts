/**
 * Growth Studio writeback reconcile worker.
 *
 * The live notify_growth_studio_lead_event trigger (migration 20260604) records
 * every LI→DGS conversion lifecycle event in public.growth_studio_outbox and fires
 * a best-effort pg_net POST. pg_net is fire-and-forget with no retry, so this worker
 * is the delivery guarantee: it invokes the in-database reconcile RPC
 * (migration 20260605) which reads the pg_net result, marks rows delivered/failed,
 * and re-POSTs undelivered ones until max_retries.
 *
 * Why an RPC and not supabase-js: the reconcile reads net._http_response, which
 * lives in the `net` schema that supabase-js cannot query — so the logic is a
 * SECURITY DEFINER function and this route just calls it.
 *
 * NOTE (history): an earlier design drained a separate growth_studio_event_outbox
 * table directly here. That table was superseded by growth_studio_outbox and does
 * not exist in the database; this route no longer references it. Draining it (a
 * missing relation) only stayed invisible because the not-armed fast path returns
 * before the query — it would have thrown on the first armed run.
 *
 * Schedule: every 10 minutes (vercel.json). Heartbeats to cron_runs via withCron —
 * a stale heartbeat means writeback reconciliation has silently stopped.
 */

import * as Sentry from '@sentry/nextjs'
import { withCron } from '@/lib/cron/with-cron'

const MAX_RETRIES = 5

type ReconcileRow = {
  outbox_id: string
  new_status: string
  status_code: number | null
  error_msg: string | null
}

export const POST = withCron('reconcile-growth-studio-outbox', async ({ supabase }) => {
  // Fast path: nothing to reconcile until the writeback is armed.
  const { data: cfg } = await supabase
    .from('growth_studio_webhook_config')
    .select('enabled')
    .limit(1)
    .maybeSingle()

  if (!cfg || !cfg.enabled) {
    return { status: 'skipped', items: 0, data: { processed: 0, reason: 'not_armed' } }
  }

  // The RPC returns one row per outbox row that changed state this sweep.
  const { data, error } = await supabase.rpc('reconcile_growth_studio_outbox', {
    max_retries: MAX_RETRIES,
  })

  // Throw so withCron records a 'failed' heartbeat + Sentry, instead of a silent 500.
  if (error) throw new Error(`reconcile RPC failed: ${error.message}`)

  const changed = (data ?? []) as ReconcileRow[]
  const byStatus = changed.reduce<Record<string, number>>((acc, r) => {
    acc[r.new_status] = (acc[r.new_status] ?? 0) + 1
    return acc
  }, {})

  // A transition to 'failed' means a conversion exhausted retries — surface it so
  // dropped revenue signal isn't invisible.
  const failed = changed.filter((r) => r.new_status === 'failed')
  if (failed.length > 0) {
    Sentry.captureMessage(`growth-studio writeback: ${failed.length} event(s) failed delivery`, {
      level: 'warning',
      extra: { failed },
    })
  }

  return { items: changed.length, data: { processed: changed.length, by_status: byStatus } }
})

export const GET = POST
