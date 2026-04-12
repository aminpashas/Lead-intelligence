import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { autoEnrollLeads } from '@/lib/campaigns/enrollments'
import { executeCampaignSteps } from '@/lib/campaigns/executor'
import { runDisqualificationRules } from '@/lib/ai/disqualification'
import { sendAppointmentReminders } from '@/lib/campaigns/reminders'
import { logger } from '@/lib/logger'

// POST /api/cron/campaigns — Daily cron (9 AM UTC) or manual trigger
// Runs: auto-enrollment, step execution, and lead disqualification
export async function POST(request: NextRequest) {
  // Verify cron secret (Vercel sends this)
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()

  // Use service role client for admin access (not anon key)
  const supabase = createServiceClient()

  // Get all active organizations
  const { data: orgs } = await supabase
    .from('organizations')
    .select('id')

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ message: 'No organizations', enrollments: 0, executions: 0 })
  }

  let totalEnrolled = 0
  let totalExecuted = 0
  const errors: string[] = []

  for (const org of orgs) {
    // PHASE 1: Auto-enroll leads into active campaigns
    const { data: activeCampaigns } = await supabase
      .from('campaigns')
      .select('*, steps:campaign_steps(step_number, delay_minutes)')
      .eq('organization_id', org.id)
      .eq('status', 'active')

    if (activeCampaigns) {
      for (const campaign of activeCampaigns) {
        try {
          const firstStepDelay = campaign.steps?.[0]?.delay_minutes ?? 0
          const enrolled = await autoEnrollLeads(supabase, campaign, firstStepDelay)
          totalEnrolled += enrolled
        } catch (err) {
          errors.push(`Enroll error (campaign ${campaign.id}): ${err instanceof Error ? err.message : 'unknown'}`)
        }
      }
    }

    // PHASE 2: Execute due steps
    try {
      const results = await executeCampaignSteps(supabase, org.id)
      totalExecuted += results.filter((r) => r.action === 'sent').length
      results.filter((r) => r.action === 'error').forEach((r) => {
        errors.push(`Exec error (lead ${r.lead_id}): ${r.detail}`)
      })
    } catch (err) {
      errors.push(`Exec error (org ${org.id}): ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }

  // PHASE 3: Run disqualification rules
  let disqualified = 0
  for (const org of orgs) {
    try {
      const result = await runDisqualificationRules(org.id)
      disqualified += result.actions.length
    } catch (err) {
      errors.push(`Disqualify error (org ${org.id}): ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }

  // PHASE 4: Send appointment reminders (24h + 1h)
  let remindersSent = 0
  for (const org of orgs) {
    try {
      const results = await sendAppointmentReminders(supabase, org.id)
      remindersSent += results.filter((r) => r.status === 'sent').length
      results.filter((r) => r.status === 'error').forEach((r) => {
        errors.push(`Reminder error (apt ${r.appointment_id}): ${r.detail}`)
      })
    } catch (err) {
      errors.push(`Reminder error (org ${org.id}): ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }

  const duration = Date.now() - startTime
  const summary = {
    success: true,
    enrollments: totalEnrolled,
    executions: totalExecuted,
    disqualified,
    remindersSent,
    errors: errors.length > 0 ? errors : undefined,
    durationMs: duration,
    orgsProcessed: orgs.length,
    timestamp: new Date().toISOString(),
  }

  logger.info('Campaign cron completed', summary)

  if (errors.length > 0) {
    logger.warn('Campaign cron had errors', { errorCount: errors.length, errors: errors.slice(0, 10) })
  }

  return NextResponse.json(summary)
}

// Vercel Cron sends GET requests
export async function GET(request: NextRequest) {
  return POST(request)
}
