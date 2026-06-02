/**
 * /api/v1/performance — service-key authenticated CRM performance rollup.
 *
 * Companion to /api/v1/leads. Consumed by sibling Vercel projects
 * (dion-growth-studio) to close the marketing→revenue loop: lead volume,
 * funnel conversion, realized revenue, and open pipeline value for one
 * customer (organization_id). Admin-level: uses the service role and the
 * caller-supplied customer_id maps 1:1 to organization_id.
 *
 * GET /api/v1/performance?customer_id=<org-uuid>&days=<n>
 *   Aggregate ONLY — no PII in the response. Audited as an aggregate PHI read.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyServiceKey } from '@/lib/auth/service-key'
import { auditPHIRead } from '@/lib/hipaa-audit'

const MAX_ROWS = 10000

function serviceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase service role not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

// GET /api/v1/performance?customer_id=<org-uuid>&days=<n>
export async function GET(request: NextRequest) {
  const caller = verifyServiceKey(request)
  if (!caller) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const customerId = searchParams.get('customer_id')
  if (!customerId) {
    return NextResponse.json({ error: 'customer_id is required' }, { status: 400 })
  }
  const days = Math.min(365, Math.max(1, parseInt(searchParams.get('days') ?? '30') || 30))
  const since = new Date(Date.now() - days * 86_400_000).toISOString()

  const supabase = serviceRoleClient()

  // Stage map — which pipeline stages count as won / lost for this org.
  const { data: stages } = await supabase
    .from('pipeline_stages')
    .select('id, is_won, is_lost')
    .eq('organization_id', customerId)
  const wonStages = new Set((stages ?? []).filter((s) => s.is_won).map((s) => s.id))
  const lostStages = new Set((stages ?? []).filter((s) => s.is_lost).map((s) => s.id))

  // Lightweight, PII-free lead rows for aggregation.
  const { data: leads, error } = await supabase
    .from('leads')
    .select('status, stage_id, ai_qualification, source_type, treatment_value, actual_revenue, created_at, lead_source:lead_sources(name)')
    .eq('organization_id', customerId)
    .order('created_at', { ascending: false })
    .range(0, MAX_ROWS - 1)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (leads ?? []) as Record<string, unknown>[]

  // Status-based won/lost fallback for leads with no stage assigned.
  const WON_STATUS = new Set(['contract_signed', 'scheduled', 'in_treatment', 'completed'])
  const LOST_STATUS = new Set(['lost', 'disqualified'])

  const byStatus: Record<string, number> = {}
  const byQualification: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  let won = 0
  let lost = 0
  let open = 0
  let wonRevenue = 0
  let pipelineValue = 0
  let newInWindow = 0

  for (const l of rows) {
    const status = String(l.status ?? 'new')
    byStatus[status] = (byStatus[status] ?? 0) + 1

    const qual = String(l.ai_qualification ?? 'unscored')
    byQualification[qual] = (byQualification[qual] ?? 0) + 1

    const sourceName =
      ((l.lead_source as { name?: string } | null)?.name) ??
      (l.source_type as string) ??
      'unknown'
    bySource[sourceName] = (bySource[sourceName] ?? 0) + 1

    const stageId = l.stage_id as string | null
    const isWon = (stageId !== null && wonStages.has(stageId)) || WON_STATUS.has(status)
    const isLost = (stageId !== null && lostStages.has(stageId)) || LOST_STATUS.has(status)
    if (isWon) {
      won++
      wonRevenue += Number(l.actual_revenue ?? l.treatment_value ?? 0) || 0
    } else if (isLost) {
      lost++
    } else {
      open++
      pipelineValue += Number(l.treatment_value ?? 0) || 0
    }

    if (String(l.created_at) >= since) newInWindow++
  }

  const total = rows.length
  const decided = won + lost
  const conversionRate = decided > 0 ? won / decided : 0

  // Top sources by lead count.
  const bySourceTop = Object.fromEntries(
    Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 10),
  )

  await auditPHIRead(
    { supabase, organizationId: customerId, actorType: 'system', actorId: caller },
    'lead',
    `bridge:perf:${caller}`,
    `Service-key performance rollup by ${caller} (${total} leads)`,
  )

  return NextResponse.json({
    customer_id: customerId,
    window_days: days,
    generated_at: new Date().toISOString(),
    truncated: total >= MAX_ROWS,
    leads: {
      total,
      new_in_window: newInWindow,
      by_status: byStatus,
      by_qualification: byQualification,
      by_source: bySourceTop,
    },
    funnel: {
      won,
      lost,
      open,
      conversion_rate: Number(conversionRate.toFixed(4)),
    },
    revenue: {
      won_revenue: Math.round(wonRevenue),
      pipeline_value: Math.round(pipelineValue),
      avg_won_revenue: won > 0 ? Math.round(wonRevenue / won) : 0,
    },
  })
}
