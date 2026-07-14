/**
 * Auto-enroll sweep cron.
 *
 * POST /api/cron/voice-campaign-enroll — tops up the dial queue of every standing
 * calling automation (campaigns with target_criteria.auto_enroll = true) so leads
 * that enter the audience stage after launch still get called. Idempotent: leads
 * already queued are skipped.
 *
 * Auth: Vercel cron Bearer secret. Accepts GET and POST (Vercel cron issues GET).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { sweepAutoEnrollQueues } from '@/lib/voice/campaign-dialer'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const supabase = createServiceClient()

  try {
    const result = await sweepAutoEnrollQueues(supabase)
    return NextResponse.json({ ok: true, ...result, ms: Date.now() - startedAt })
  } catch (error) {
    logger.error('Auto-enroll sweep failed', {}, error instanceof Error ? error : undefined)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return POST(request)
}
