/**
 * Daily ops digest — surfaces silent failures across the delivery pipelines.
 *
 * Read-only. Counts, over the last 24h where time-bounded:
 *   - events with capi_status='failed' or gads_status='failed'
 *   - growth_studio_outbox rows with status='failed'
 *   - open escalations (status in 'pending'/'claimed')
 *
 * If anything is non-zero it emits a Sentry warning and a structured console
 * line, then returns the counts as JSON. Mutates nothing.
 *
 * Schedule: once daily (vercel.json).
 */

import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { createServiceClient } from '@/lib/supabase/server'

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

  const [capiFailed, gadsFailed, outboxFailed, openEscalations] = await Promise.all([
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
        .eq('status', 'failed')
    ),
    countOf(
      supabase
        .from('escalations')
        .select('id', { count: 'exact', head: true })
        .in('status', ['pending', 'claimed'])
    ),
  ])

  const counts = {
    capi_failed_24h: capiFailed,
    gads_failed_24h: gadsFailed,
    outbox_failed: outboxFailed,
    open_escalations: openEscalations,
  }

  const total =
    capiFailed + gadsFailed + outboxFailed + openEscalations

  if (total > 0) {
    console.warn(
      `[ops-digest] ${total} failures need attention`,
      JSON.stringify(counts)
    )
    Sentry.captureMessage(`ops-digest: ${total} failures need attention`, {
      level: 'warning',
      extra: counts,
    })
  }

  return NextResponse.json({ total, ...counts })
}

export const GET = POST
