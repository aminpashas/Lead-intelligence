import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'

// GET /api/agents/protocol-changes?limit=50&agent_id=uuid?
//
// Audit feed for the /agent-kpi/protocols page. Returns the most
// recent reward/discipline actions and protocol swaps across the
// org — joined with agent name + cap state for context.
export async function GET(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const limitParam = Number(request.nextUrl.searchParams.get('limit') ?? '50')
  const limit = Math.min(Math.max(limitParam, 1), 200)
  const agentIdParam = request.nextUrl.searchParams.get('agent_id')

  let changesQuery = supabase
    .from('agent_protocol_changes')
    .select('id, agent_id, change_type, triggered_by, from_protocol_id, to_protocol_id, from_multiplier, to_multiplier, reason, reference_review_id, created_by, created_at')
    .eq('organization_id', profile.organization_id)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (agentIdParam) {
    changesQuery = changesQuery.eq('agent_id', agentIdParam)
  }

  const [changesResult, capsResult, agentsResult] = await Promise.all([
    changesQuery,
    supabase
      .from('agent_lead_caps')
      .select('agent_id, base_daily_cap, multiplier, autopilot_mode_override, updated_at')
      .eq('organization_id', profile.organization_id),
    supabase
      .from('ai_agents')
      .select('id, name, role')
      .eq('organization_id', profile.organization_id)
      .eq('is_active', true),
  ])

  if (changesResult.error) {
    return NextResponse.json({ error: changesResult.error.message }, { status: 500 })
  }

  return NextResponse.json({
    changes: changesResult.data ?? [],
    caps: capsResult.data ?? [],
    agents: agentsResult.data ?? [],
  })
}
