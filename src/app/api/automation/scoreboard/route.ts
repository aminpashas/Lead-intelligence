import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { requirePermission } from '@/lib/auth/active-org'
import { logger } from '@/lib/logger'

/**
 * GET /api/automation/scoreboard?days=7|30|90
 *
 * AI-vs-Human scoreboard for the Command Center: proxies the two org-guarded
 * RPCs (automation_scoreboard + automation_outcomes — migration
 * 20260711223000). Attribution is TOUCH-BASED, not causal lift; the client
 * labels it as such.
 *
 * If the RPCs are not deployed yet (migration pending), returns 200 with
 * `available: false` so the page renders a friendly placeholder instead of an
 * error wall.
 */

const ALLOWED_DAYS = new Set([7, 30, 90])

export async function GET(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()
  const guard = await requirePermission(supabase, 'ai_control:read')
  if ('error' in guard) return guard.error

  const days = Number(request.nextUrl.searchParams.get('days') ?? 30)
  if (!ALLOWED_DAYS.has(days)) {
    return NextResponse.json({ error: 'days must be 7, 30 or 90' }, { status: 400 })
  }

  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
  const args = {
    p_org_id: guard.orgId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  }

  const [lanes, outcomes] = await Promise.all([
    supabase.rpc('automation_scoreboard', args),
    supabase.rpc('automation_outcomes', args),
  ])

  if (lanes.error || outcomes.error) {
    // Most likely cause: the scoreboard migration has not been applied to this
    // environment yet. Degrade gracefully — the rest of the page still works.
    logger.warn('Scoreboard RPC failed', {
      organization_id: guard.orgId,
      lanes_error: lanes.error?.message,
      outcomes_error: outcomes.error?.message,
    })
    return NextResponse.json({
      available: false,
      error: lanes.error?.message ?? outcomes.error?.message ?? 'scoreboard unavailable',
    })
  }

  return NextResponse.json({
    available: true,
    days,
    from: args.p_from,
    to: args.p_to,
    lanes: lanes.data ?? [],
    outcomes: outcomes.data ?? [],
  })
}
