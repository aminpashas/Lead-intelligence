import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import {
  computeKpiStatus,
  KPI_DISPLAY_ORDER,
  type KpiTarget,
} from '@/lib/agents/kpi-status'

// GET /api/analytics/agent-kpi
//   ?start=ISO (default -30d) &end=ISO (default now) &agent_id=uuid?
//
// Returns { agents: [{ id, name, role, kpis: { name: { value, target,
// warning, critical, direction, status } }, raw: {…counts…} }] }.
//
// KPI math lives in the get_agent_kpi_summary RPC (migration 031);
// this route layers on targets and status flags.
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

  const orgId = profile.organization_id

  const startParam = request.nextUrl.searchParams.get('start')
  const endParam = request.nextUrl.searchParams.get('end')
  const agentIdParam = request.nextUrl.searchParams.get('agent_id')

  const startDate = startParam
    ? new Date(startParam).toISOString()
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const endDate = endParam
    ? new Date(endParam).toISOString()
    : new Date().toISOString()

  // Fetch KPI summary + targets in parallel
  const [summaryResult, targetsResult] = await Promise.all([
    supabase.rpc('get_agent_kpi_summary', {
      p_org_id: orgId,
      p_start: startDate,
      p_end: endDate,
      p_agent_id: agentIdParam || null,
    }),
    supabase
      .from('agent_kpi_targets')
      .select('agent_id, kpi_name, target_value, warning_threshold, critical_threshold, direction')
      .eq('organization_id', orgId),
  ])

  if (summaryResult.error) {
    return NextResponse.json({ error: summaryResult.error.message }, { status: 500 })
  }

  const rawAgents = (summaryResult.data as Array<{
    id: string
    name: string
    role: string
    kpis: Record<string, number | null>
    raw: Record<string, number | null>
  }>) || []

  const targetsByAgent = new Map<string, Map<string, KpiTarget>>()
  for (const t of targetsResult.data || []) {
    const inner = targetsByAgent.get(t.agent_id) ?? new Map<string, KpiTarget>()
    inner.set(t.kpi_name, {
      kpi_name: t.kpi_name,
      target_value: Number(t.target_value),
      warning_threshold: Number(t.warning_threshold),
      critical_threshold: Number(t.critical_threshold),
      direction: t.direction,
    })
    targetsByAgent.set(t.agent_id, inner)
  }

  const agents = rawAgents.map((agent) => {
    const agentTargets = targetsByAgent.get(agent.id) ?? new Map<string, KpiTarget>()

    const kpis: Record<string, {
      value: number | null
      target: number | null
      warning: number | null
      critical: number | null
      direction: string | null
      status: ReturnType<typeof computeKpiStatus>
    }> = {}

    for (const kpiName of KPI_DISPLAY_ORDER) {
      const rawValue = agent.kpis?.[kpiName]
      const value = rawValue === null || rawValue === undefined ? null : Number(rawValue)
      const target = agentTargets.get(kpiName) ?? null
      const status = computeKpiStatus(value, target)

      kpis[kpiName] = {
        value,
        target: target?.target_value ?? null,
        warning: target?.warning_threshold ?? null,
        critical: target?.critical_threshold ?? null,
        direction: target?.direction ?? null,
        status,
      }
    }

    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      kpis,
      raw: agent.raw ?? {},
    }
  })

  return NextResponse.json({
    agents,
    dateRange: { start: startDate, end: endDate },
  })
}
