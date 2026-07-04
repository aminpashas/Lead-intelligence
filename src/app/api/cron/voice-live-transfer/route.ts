/**
 * Live-Transfer Dispatcher cron.
 *
 * POST /api/cron/voice-live-transfer — runs a dispatch tick: for every org with
 * live transfer armed, dials as many queued campaign leads as can currently be
 * handed off to a live rep. Safe to run frequently; each tick is bounded by rep
 * availability and the org's hourly rate limit.
 *
 * Auth: Vercel cron Bearer secret (same pattern as the other crons). Also
 * invocable manually with the same header for smoke tests.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { runDispatchTick } from '@/lib/voice/dispatcher'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const supabase = createServiceClient()

  try {
    const result = await runDispatchTick(supabase)
    logger.info('Live-transfer dispatch tick complete', { ...result, ms: Date.now() - startedAt })
    return NextResponse.json({ ok: true, ...result, ms: Date.now() - startedAt })
  } catch (error) {
    logger.error('Live-transfer dispatch tick failed', {}, error instanceof Error ? error : undefined)
    return NextResponse.json({ error: 'Dispatch failed' }, { status: 500 })
  }
}

// Vercel cron issues GET by default in some configs; accept both.
export async function GET(request: NextRequest) {
  return POST(request)
}
