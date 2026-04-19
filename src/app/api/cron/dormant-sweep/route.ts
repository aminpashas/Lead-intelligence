/**
 * Dormant Lead Sweep — daily.
 *
 * For every active organization:
 *   1. Find leads with no activity in > 60 days that are not already terminal/dormant.
 *   2. Flip their status to 'dormant'.
 *   3. Enroll them in the seeded "Reactivation" campaign (created by migration 024).
 *   4. Append a `lead.dormant.flagged` event row.
 *
 * Activity is measured by the most recent of: last_contacted_at, last_responded_at, updated_at.
 *
 * Brief reference: Section 2.5 (lead.dormant.sweep).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

const DORMANT_THRESHOLD_DAYS = 60

// Statuses that should NOT be swept (terminal or already dormant).
const TERMINAL_STATUSES = ['completed', 'lost', 'disqualified', 'dormant', 'in_treatment']

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const cutoff = new Date(Date.now() - DORMANT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const { data: orgs } = await supabase
    .from('organizations')
    .select('id')
    .eq('subscription_status', 'active')

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ message: 'No active organizations', flagged: 0 })
  }

  let totalFlagged = 0
  const orgResults: Array<{ organization_id: string; flagged: number; enrolled: number }> = []

  for (const org of orgs) {
    // Find dormant candidates. We use the OR of last_contacted_at + last_responded_at + updated_at,
    // accepting that any of those being recent disqualifies the lead. Fall back to created_at when null.
    const { data: candidates } = await supabase
      .from('leads')
      .select('id, status, last_contacted_at, last_responded_at, updated_at, created_at')
      .eq('organization_id', org.id)
      .not('status', 'in', `(${TERMINAL_STATUSES.join(',')})`)
      .or(
        `and(last_contacted_at.is.null,last_responded_at.is.null,updated_at.lt.${cutoff})`
        + `,and(last_contacted_at.lt.${cutoff},or(last_responded_at.is.null,last_responded_at.lt.${cutoff}))`
      )

    if (!candidates || candidates.length === 0) {
      orgResults.push({ organization_id: org.id, flagged: 0, enrolled: 0 })
      continue
    }

    // Look up the seeded Reactivation campaign + first step delay.
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('id')
      .eq('organization_id', org.id)
      .eq('name', 'Reactivation')
      .eq('status', 'active')
      .single()

    let firstStepDelay = 0
    if (campaign) {
      const { data: firstStep } = await supabase
        .from('campaign_steps')
        .select('delay_minutes')
        .eq('campaign_id', campaign.id)
        .eq('step_number', 1)
        .single()
      firstStepDelay = firstStep?.delay_minutes ?? 0
    }

    const leadIds = (candidates as Array<{ id: string }>).map((l) => l.id)
    const nowIso = new Date().toISOString()

    // Flip status to dormant
    await supabase
      .from('leads')
      .update({ status: 'dormant' })
      .in('id', leadIds)

    // Enroll in Reactivation
    let enrolled = 0
    if (campaign) {
      const nextStepAt = new Date(Date.now() + firstStepDelay * 60 * 1000).toISOString()
      const enrollments = leadIds.map((leadId: string) => ({
        organization_id: org.id,
        campaign_id: campaign.id,
        lead_id: leadId,
        status: 'active' as const,
        current_step: 0,
        next_step_at: nextStepAt,
      }))
      const { error: enrollErr } = await supabase
        .from('campaign_enrollments')
        .upsert(enrollments, { onConflict: 'campaign_id,lead_id', ignoreDuplicates: true })
      if (!enrollErr) enrolled = leadIds.length
    }

    // Append events for the audit trail / analytics surface
    const eventRows = leadIds.map((leadId: string) => ({
      organization_id: org.id,
      lead_id: leadId,
      event_type: 'lead.dormant.flagged',
      payload: {
        threshold_days: DORMANT_THRESHOLD_DAYS,
        flagged_at: nowIso,
        enrolled_in_reactivation: !!campaign,
      },
    }))
    await supabase.from('events').insert(eventRows)

    // Activity log entries (mirrors what the existing UI expects)
    const activityRows = leadIds.map((leadId: string) => ({
      organization_id: org.id,
      lead_id: leadId,
      activity_type: 'status_changed',
      title: 'Marked dormant — no activity > 60 days',
      metadata: { from_status: 'various', to_status: 'dormant', sweep: true },
    }))
    await supabase.from('lead_activities').insert(activityRows)

    totalFlagged += leadIds.length
    orgResults.push({ organization_id: org.id, flagged: leadIds.length, enrolled })
  }

  return NextResponse.json({
    success: true,
    threshold_days: DORMANT_THRESHOLD_DAYS,
    total_flagged: totalFlagged,
    organizations: orgResults,
  })
}

// Vercel cron makes GET requests by default; alias to POST handler.
export const GET = POST
