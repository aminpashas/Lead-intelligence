import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { isActionQueueCohortKey, type ActionQueueCohortPage } from '@/lib/analytics/deep-types'

/**
 * GET /api/analytics/action-queue/:cohort — the paginated lead list behind an
 * Action Center tile/recommendation.
 *
 * Backed by get_action_queue_cohort(), which shares its membership predicate
 * with the tile counts (analytics_in_action_cohort) — the list always adds up
 * to the number on the card. Returns only non-PII columns (name is stored in
 * plaintext; phone/email are encrypted and deliberately not exposed here — the
 * per-lead link goes to the lead detail page for that).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ cohort: string }> }
) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const { cohort } = await params
  if (!isActionQueueCohortKey(cohort)) {
    return NextResponse.json({ error: `Unknown cohort "${cohort}"` }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: profile } = await getOwnProfile(supabase, 'organization_id')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sp = request.nextUrl.searchParams
  const limit = Math.min(200, Math.max(1, parseInt(sp.get('limit') || '50', 10) || 50))
  const offset = Math.max(0, parseInt(sp.get('offset') || '0', 10) || 0)

  const { data, error } = await supabase.rpc('get_action_queue_cohort', {
    p_org_id: orgId,
    p_cohort: cohort,
    p_limit: limit,
    p_offset: offset,
  })

  if (error) {
    // Missing function = migration 20260712100000 not applied to this env yet.
    return NextResponse.json(
      { error: `Action-queue cohort RPC failed: ${error.message}` },
      { status: 500 }
    )
  }

  return NextResponse.json(data as ActionQueueCohortPage)
}
