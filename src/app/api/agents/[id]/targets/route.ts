import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { isAdminRole } from '@/lib/auth/permissions'

type TargetUpdate = {
  kpi_name: string
  target_value: number
  warning_threshold: number
  critical_threshold: number
  direction: 'higher_is_better' | 'lower_is_better'
}

// GET /api/agents/[id]/targets — Return all target rows for an agent.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const { id: agentId } = await params
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('agent_kpi_targets')
    .select('id, kpi_name, target_value, warning_threshold, critical_threshold, direction, updated_at')
    .eq('agent_id', agentId)
    .eq('organization_id', profile.organization_id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ targets: data || [] })
}

// PATCH /api/agents/[id]/targets — Upsert target rows. Admin-gated.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const { id: agentId } = await params
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!isAdminRole(profile.role)) {
    return NextResponse.json({ error: 'Only admins can edit targets' }, { status: 403 })
  }

  // Confirm the agent belongs to this org (defence-in-depth against crafted IDs)
  const { data: agent } = await supabase
    .from('ai_agents')
    .select('id')
    .eq('id', agentId)
    .eq('organization_id', profile.organization_id)
    .maybeSingle()

  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  let body: { targets?: TargetUpdate[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const targets = body.targets
  if (!Array.isArray(targets) || targets.length === 0) {
    return NextResponse.json({ error: 'targets array required' }, { status: 400 })
  }

  for (const t of targets) {
    if (!t.kpi_name || typeof t.target_value !== 'number' ||
        typeof t.warning_threshold !== 'number' ||
        typeof t.critical_threshold !== 'number' ||
        (t.direction !== 'higher_is_better' && t.direction !== 'lower_is_better')) {
      return NextResponse.json({ error: `Invalid target: ${JSON.stringify(t)}` }, { status: 400 })
    }
  }

  const rows = targets.map((t) => ({
    agent_id: agentId,
    organization_id: profile.organization_id,
    kpi_name: t.kpi_name,
    target_value: t.target_value,
    warning_threshold: t.warning_threshold,
    critical_threshold: t.critical_threshold,
    direction: t.direction,
    updated_at: new Date().toISOString(),
  }))

  const { error } = await supabase
    .from('agent_kpi_targets')
    .upsert(rows, { onConflict: 'agent_id,kpi_name' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, updated: rows.length })
}
