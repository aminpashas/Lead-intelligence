/**
 * Reconcile sweep for the Growth Studio writeback outbox.
 *
 * The DGS writeback (SQL trigger notify_growth_studio_lead_event) fires via
 * pg_net fire-and-forget and records the request id in growth_studio_outbox.
 * pg_net is async and can fail silently, so this cron makes those deliveries
 * recoverable: it calls the SECURITY DEFINER function reconcile_growth_studio_outbox()
 * (see 20260605_growth_studio_outbox_reconcile.sql) which reads net._http_response,
 * marks 2xx rows delivered, retries non-2xx rows (re-POSTing and capturing the new
 * request id), and marks rows failed once attempts exhaust max_retries.
 *
 * Any row transitioning to 'failed' is surfaced to Sentry.
 *
 * Schedule: every 10 minutes (vercel.json).
 */

import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { createServiceClient } from '@/lib/supabase/server'

const MAX_RETRIES = 5

type ReconcileRow = {
  outbox_id: string
  new_status: string
  status_code: number | null
  error_msg: string | null
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  const { data, error } = await supabase.rpc('reconcile_growth_studio_outbox', {
    max_retries: MAX_RETRIES,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (data ?? []) as ReconcileRow[]

  const summary = {
    changed: rows.length,
    delivered: rows.filter((r) => r.new_status === 'delivered').length,
    retried: rows.filter((r) => r.new_status === 'pending').length,
    failed: rows.filter((r) => r.new_status === 'failed').length,
    unknown: rows.filter((r) => r.new_status === 'unknown').length,
  }

  // Surface hard delivery failures so they don't vanish silently.
  if (summary.failed > 0) {
    const failedIds = rows.filter((r) => r.new_status === 'failed').map((r) => r.outbox_id)
    Sentry.captureMessage('growth_studio_outbox delivery failed', {
      level: 'error',
      extra: { count: summary.failed, ids: failedIds },
    })
  }

  return NextResponse.json(summary)
}

export const GET = POST
