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
import { verifyServiceKey, isOrgAllowed } from '@/lib/auth/service-key'
import { auditPHIRead } from '@/lib/hipaa-audit'
import { logger } from '@/lib/logger'

function serviceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase service role not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

// GET /api/v1/performance?customer_id=<org-uuid>&days=<n>
export async function GET(request: NextRequest) {
  const auth = verifyServiceKey(request)
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const caller = auth.caller

  const { searchParams } = new URL(request.url)
  const customerId = searchParams.get('customer_id')
  if (!customerId) {
    return NextResponse.json({ error: 'customer_id is required' }, { status: 400 })
  }
  // Multi-tenant guard: a caller may only roll up its allowlisted orgs.
  if (!isOrgAllowed(auth, customerId)) {
    return NextResponse.json({ error: 'forbidden_org' }, { status: 403 })
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

  // Status-based won/lost fallback for leads with no stage assigned. "Won" means
  // realized — only 'completed' counts (treatment delivered). In-flight statuses
  // like 'scheduled' / 'in_treatment' / 'contract_signed' are pipeline, not won.
  const WON_STATUS = new Set(['completed'])
  const LOST_STATUS = new Set(['lost', 'disqualified'])

  const byStatus: Record<string, number> = {}
  const byQualification: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  let won = 0
  let lost = 0
  let open = 0
  let wonRevenue = 0
  let pipelineValue = 0
  let total = 0

  // Paginate the fetch so orgs with >10k leads in the window aren't silently
  // truncated. Aggregation happens incrementally per page, so memory stays bounded
  // and every row in the window is counted. PAGE_SIZE × MAX_PAGES caps the work.
  const PAGE_SIZE = 1000
  const MAX_PAGES = 500 // up to 500k leads/window
  let pagesFetched = 0
  let truncated = false

  for (; pagesFetched < MAX_PAGES; pagesFetched++) {
    const from = pagesFetched * PAGE_SIZE
    const { data: page, error } = await supabase
      .from('leads')
      .select('id, status, stage_id, ai_qualification, source_type, treatment_value, actual_revenue, created_at, lead_source:lead_sources(name)')
      .eq('organization_id', customerId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const rows = (page ?? []) as Record<string, unknown>[]
    for (const l of rows) {
      total++
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
      // Prefer the explicit pipeline STAGE when present (stages are the source of
      // truth for won/lost); fall back to status only when no won/lost stage applies.
      const stageWon = stageId !== null && wonStages.has(stageId)
      const stageLost = stageId !== null && lostStages.has(stageId)
      const statusWon = WON_STATUS.has(status)
      const statusLost = LOST_STATUS.has(status)

      // Surface stage/status disagreements so data drift is visible; stage wins.
      if ((stageWon && statusLost) || (stageLost && statusWon)) {
        logger.warn('lead won/lost stage and status disagree (using stage)', {
          lead_id: String(l.id),
          stage_won: stageWon,
          stage_lost: stageLost,
          status,
        })
      }

      const isWon = stageWon || (!stageLost && statusWon)
      const isLost = stageLost || (!stageWon && statusLost)
      if (isWon) {
        won++
        // Realized revenue only — actual_revenue, never the treatment_value quote.
        wonRevenue += Number(l.actual_revenue ?? 0) || 0
      } else if (isLost) {
        lost++
      } else {
        open++
        pipelineValue += Number(l.treatment_value ?? 0) || 0
      }
    }

    if (rows.length < PAGE_SIZE) break // last page
    if (pagesFetched + 1 >= MAX_PAGES) {
      truncated = true
      logger.warn('performance rollup hit MAX_PAGES cap', { customer_id: customerId, counted: total })
    }
  }
  // All rows are now within the window (query is gte since), so new == total.
  const newInWindow = total
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
    truncated,
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
