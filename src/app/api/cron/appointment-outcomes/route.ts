import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { sweepAttendance, dispatchFeedbackRequests } from '@/lib/appointments/post-consult'
import { logger } from '@/lib/logger'

/**
 * POST /api/cron/appointment-outcomes
 *
 * Runs every 30 minutes. Two passes across all organizations:
 *   A) sweepAttendance — flags ended, undecided consults as "needs outcome"
 *      and posts a batched Slack digest for staff.
 *   B) dispatchFeedbackRequests — for opt-in practices, texts/emails a feedback
 *      request to patients whose consult outcome was recorded past the delay window.
 *
 * Protected by CRON_SECRET for Vercel Cron invocations.
 */
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const { data: orgs } = await supabase.from('organizations').select('id')
  if (!orgs?.length) {
    return NextResponse.json({ message: 'No organizations', flagged: 0, feedback_sent: 0 })
  }

  let flagged = 0
  let feedbackSent = 0
  const errors: string[] = []
  for (const org of orgs) {
    try {
      flagged += await sweepAttendance(supabase, org.id)
    } catch (e) {
      errors.push(`sweep ${org.id}: ${e instanceof Error ? e.message : 'err'}`)
    }
    try {
      feedbackSent += await dispatchFeedbackRequests(supabase, org.id)
    } catch (e) {
      errors.push(`feedback ${org.id}: ${e instanceof Error ? e.message : 'err'}`)
    }
  }

  const summary = {
    success: true,
    flagged,
    feedback_sent: feedbackSent,
    orgs_processed: orgs.length,
    errors: errors.slice(0, 20),
    timestamp: new Date().toISOString(),
  }
  logger.info('appointment-outcomes cron completed', summary)
  return NextResponse.json(summary)
}

// Vercel Cron sends GET requests
export async function GET(request: NextRequest) {
  return POST(request)
}
