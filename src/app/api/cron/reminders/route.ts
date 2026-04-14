import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { sendAppointmentReminders } from '@/lib/campaigns/reminders'
import { logger } from '@/lib/logger'

/**
 * POST /api/cron/reminders
 *
 * Dedicated appointment reminder cron — runs every 15 minutes.
 * Processes all organizations and sends due reminders across
 * SMS, Email, and AI Voice channels.
 *
 * Protected by CRON_SECRET for Vercel Cron invocations.
 */
export async function POST(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const supabase = createServiceClient()

  // Get all active organizations
  const { data: orgs } = await supabase
    .from('organizations')
    .select('id')

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ message: 'No organizations', reminders_sent: 0 })
  }

  let totalSent = 0
  let totalSkipped = 0
  let totalErrors = 0
  const errors: string[] = []

  const details: Record<string, { sent: number; skipped: number; errors: number }> = {}

  for (const org of orgs) {
    try {
      const results = await sendAppointmentReminders(supabase, org.id)

      const orgSent = results.filter((r) => r.status === 'sent').length
      const orgSkipped = results.filter((r) => r.status === 'skipped').length
      const orgErrors = results.filter((r) => r.status === 'error').length

      totalSent += orgSent
      totalSkipped += orgSkipped
      totalErrors += orgErrors

      if (results.length > 0) {
        details[org.id] = { sent: orgSent, skipped: orgSkipped, errors: orgErrors }
      }

      // Log individual errors
      results
        .filter((r) => r.status === 'error')
        .forEach((r) => {
          errors.push(`[${r.type}/${r.channel}] apt ${r.appointment_id}: ${r.detail}`)
        })
    } catch (err) {
      totalErrors++
      errors.push(`Org ${org.id}: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  const duration = Date.now() - startTime

  const summary = {
    success: true,
    reminders_sent: totalSent,
    reminders_skipped: totalSkipped,
    reminders_errors: totalErrors,
    errors: errors.length > 0 ? errors.slice(0, 20) : undefined,
    duration_ms: duration,
    orgs_processed: orgs.length,
    details: Object.keys(details).length > 0 ? details : undefined,
    timestamp: new Date().toISOString(),
  }

  logger.info('Reminder cron completed', summary)

  if (errors.length > 0) {
    logger.warn('Reminder cron had errors', { errorCount: errors.length })
  }

  return NextResponse.json(summary)
}

// Vercel Cron sends GET requests
export async function GET(request: NextRequest) {
  return POST(request)
}
