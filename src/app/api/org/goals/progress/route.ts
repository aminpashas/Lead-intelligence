/**
 * GET /api/org/goals/progress — org goals with computed actuals + on-pace status (Phase 5).
 * Powers the dashboard on-pace card.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { computeGoalProgress, type GoalMetric } from '@/lib/goals/pacing'
import { actualForMetric, type ActualLead } from '@/lib/goals/actuals'

export async function GET() {
  const authed = await createClient()
  const { data: { user } } = await authed.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await authed
    .from('user_profiles')
    .select('organization_id')
    .eq('id', user.id)
    .single()
  const orgId = profile?.organization_id
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 403 })

  const { data: goals } = await authed
    .from('org_goals')
    .select('*')
    .eq('organization_id', orgId)
    .order('period_end', { ascending: false })

  if (!goals || goals.length === 0) return NextResponse.json({ goals: [] })

  const { data: leads } = await authed
    .from('leads')
    .select('status, ai_qualification, treatment_value, actual_revenue, created_at, converted_at, consultation_date')
    .eq('organization_id', orgId)

  const rows = (leads ?? []) as ActualLead[]
  const nowIso = new Date().toISOString()

  const result = goals.map((g) => {
    const actual = actualForMetric(rows, g.metric as GoalMetric, g.period_start, g.period_end)
    const progress = computeGoalProgress({
      target: Number(g.target_value),
      actual,
      periodStart: g.period_start,
      periodEnd: g.period_end,
      now: nowIso,
    })
    return { ...g, actual, progress }
  })

  return NextResponse.json({ goals: result })
}
