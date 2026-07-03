import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { detectOutcomeEvents, assembleEpisode } from '@/lib/ai/learning/episodes'

// POST /api/cron/learning-episodes — Nightly (04:15 UTC, after technique-feedback)
//
// Detects outcome events (booked / showed / no_show / contract_signed / lost)
// from the last 2 days and backtracks each lead's full communication journey
// into learning_episodes. Windows overlap across runs; assembly upserts on
// (lead_id, outcome, outcome_ref) so re-detection is idempotent.
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const supabase = createServiceClient()
  const sinceIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

  const events = await detectOutcomeEvents(supabase, sinceIso)

  let assembled = 0
  const errors: string[] = []
  for (const event of events) {
    try {
      await assembleEpisode(supabase, event)
      assembled++
    } catch (err) {
      errors.push(`${event.outcome}/${event.lead_id}: ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }

  const summary = {
    success: true,
    detected: events.length,
    assembled,
    errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  }

  logger.info('Learning episodes cron completed', summary)
  return NextResponse.json(summary)
}

export async function GET(request: NextRequest) {
  return POST(request)
}
