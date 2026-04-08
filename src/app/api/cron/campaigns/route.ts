import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { autoEnrollLeads } from '@/lib/campaigns/enrollments'
import { executeCampaignSteps } from '@/lib/campaigns/executor'

// POST /api/cron/campaigns — Runs every 5 minutes via Vercel Cron
// 1. Auto-enrolls leads matching active campaign criteria
// 2. Executes due campaign steps (sends SMS/email)
export async function POST(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.WEBHOOK_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

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

  return NextResponse.json({
    success: true,
    enrollments: totalEnrolled,
    executions: totalExecuted,
    errors: errors.length > 0 ? errors : undefined,
    timestamp: new Date().toISOString(),
  })
}
