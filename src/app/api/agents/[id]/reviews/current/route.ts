import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'

// GET /api/agents/[id]/reviews/current
//
// Returns the agent's current status row joined with the latest
// review's reasons / kpi_scores. Used by the scorecard status pill
// and the "Latest Review" panel.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const { id: agentId } = await params
  const supabase = await createClient()

  // Auth
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: status, error: statusErr } = await supabase
    .from('agent_status_current')
    .select('agent_id, status, since, consecutive_red_periods, consecutive_green_periods, last_review_id, updated_at')
    .eq('agent_id', agentId)
    .maybeSingle()

  if (statusErr) {
    return NextResponse.json({ error: statusErr.message }, { status: 500 })
  }

  if (!status) {
    return NextResponse.json({ status: null, latest_review: null })
  }

  let latestReview = null
  if (status.last_review_id) {
    const { data: review } = await supabase
      .from('agent_performance_reviews')
      .select('id, period_start, period_end, overall_grade, kpi_scores, reasons, notes, reviewed_by, reviewed_at, acknowledged_by, acknowledged_at')
      .eq('id', status.last_review_id)
      .maybeSingle()
    latestReview = review
  }

  return NextResponse.json({ status, latest_review: latestReview })
}
