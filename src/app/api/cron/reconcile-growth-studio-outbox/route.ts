/**
 * Growth Studio writeback worker.
 *
 * Drains public.growth_studio_event_outbox — the durable record of LI→DGS
 * conversion lifecycle events written by the notify_growth_studio_lead_event
 * trigger. The trigger also does a best-effort pg_net post for low latency, but
 * pg_net has no retry, so this worker is the delivery guarantee: it (re)POSTs
 * undelivered rows and marks them delivered on success.
 *
 * Idempotent: each row carries a stable event_id (li_lead_id:stage) so a retry
 * (or the trigger's own pg_net post) is deduped on the DGS side.
 *
 * Schedule: every 10 minutes (vercel.json → /api/cron/reconcile-growth-studio-outbox).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

const BATCH_SIZE = 50
const MAX_ATTEMPTS = 8

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  const { data: cfg } = await supabase
    .from('growth_studio_webhook_config')
    .select('url, bearer, enabled')
    .limit(1)
    .maybeSingle()

  if (!cfg || !cfg.enabled) {
    return NextResponse.json({ processed: 0, reason: 'not_armed' })
  }

  const { data: rows, error } = await supabase
    .from('growth_studio_event_outbox')
    .select('id, event_id, payload, attempts')
    .eq('delivered', false)
    .lt('attempts', MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!rows || rows.length === 0) return NextResponse.json({ processed: 0 })

  let delivered = 0
  let failed = 0

  for (const row of rows) {
    try {
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.bearer}` },
        body: JSON.stringify(row.payload),
        signal: AbortSignal.timeout(10000),
      })
      if (res.ok) {
        await supabase
          .from('growth_studio_event_outbox')
          .update({ delivered: true, delivered_at: new Date().toISOString(), attempts: row.attempts + 1, last_error: null })
          .eq('id', row.id)
        delivered++
      } else {
        await supabase
          .from('growth_studio_event_outbox')
          .update({ attempts: row.attempts + 1, last_error: `HTTP ${res.status}` })
          .eq('id', row.id)
        failed++
      }
    } catch (err) {
      await supabase
        .from('growth_studio_event_outbox')
        .update({ attempts: row.attempts + 1, last_error: err instanceof Error ? err.message : 'fetch error' })
        .eq('id', row.id)
      failed++
    }
  }

  return NextResponse.json({ processed: rows.length, delivered, failed })
}

export const GET = POST
