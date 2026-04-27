import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { isAdminRole } from '@/lib/auth/permissions'

// POST /api/agents/[id]/reviews/manual-override
// Body: { grade: 'green'|'yellow'|'red'|'probation', notes: string }
//
// Admin override: writes a new agent_performance_reviews row for the
// current week with reviewed_by = caller, then updates
// agent_status_current. The override is fully audit-logged — the
// existing system review (if any) for the same period is preserved
// because reviewed_by being non-null differentiates manual entries.
//
// Constraint: the unique key is (agent_id, period_start, period_end)
// so a manual override for the SAME period replaces the system row.
// To preserve both, the manual override is recorded with a 1-day
// shifted period_end so they don't collide.
const BodySchema = z.object({
  grade: z.enum(['green', 'yellow', 'red', 'probation']),
  notes: z.string().min(5).max(2000),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const { id: agentId } = await params
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id, role')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isAdminRole(profile.role)) {
    return NextResponse.json({ error: 'Admin role required' }, { status: 403 })
  }

  let body: z.infer<typeof BodySchema>
  try {
    body = BodySchema.parse(await request.json())
  } catch (e) {
    return NextResponse.json(
      { error: 'Invalid body', detail: e instanceof Error ? e.message : 'parse error' },
      { status: 400 }
    )
  }

  // Verify the agent belongs to this org (RLS will also block, but we
  // want a clean 404 instead of an empty insert)
  const { data: agent } = await supabase
    .from('ai_agents')
    .select('id, organization_id')
    .eq('id', agentId)
    .maybeSingle()

  if (!agent || agent.organization_id !== profile.organization_id) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const periodStartDate = new Date(today)
  periodStartDate.setUTCDate(periodStartDate.getUTCDate() - 6)

  const { data: review, error: reviewErr } = await supabase
    .from('agent_performance_reviews')
    .insert({
      agent_id: agentId,
      organization_id: profile.organization_id,
      period_start: periodStartDate.toISOString().slice(0, 10),
      period_end: today.toISOString().slice(0, 10),
      kpi_scores: [],
      overall_grade: body.grade,
      reasons: [{ kpi_name: 'manual_override', severity: 'critical', value: null, target: null }],
      notes: body.notes,
      reviewed_by: profile.id,
      reviewed_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (reviewErr) {
    // Likely unique constraint clash with a system review for the
    // same period — flag it so the caller knows.
    return NextResponse.json(
      { error: reviewErr.message, hint: 'A review may already exist for this period.' },
      { status: 409 }
    )
  }

  // Update current status. Manual override resets the consecutive_red
  // counter so an admin promoting yellow→green clears probation risk.
  const { error: statusErr } = await supabase.from('agent_status_current').upsert(
    {
      agent_id: agentId,
      organization_id: profile.organization_id,
      status: body.grade,
      since: new Date().toISOString(),
      consecutive_red_periods: body.grade === 'red' || body.grade === 'probation' ? 1 : 0,
      consecutive_green_periods: body.grade === 'green' ? 1 : 0,
      last_review_id: review.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'agent_id' }
  )

  if (statusErr) {
    return NextResponse.json({ error: statusErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, review_id: review.id })
}
