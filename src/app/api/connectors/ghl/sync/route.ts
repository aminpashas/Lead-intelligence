/**
 * POST /api/connectors/ghl/sync — manual "Sync now" trigger.
 *
 * Runs the same GHL → LI sync the cron runs, but on demand for the caller's
 * active practice. Auth-gated to an agency/client org; the actual sync runs on
 * a service-role client (like the cron) so it can write leads, stages, and
 * activities without tripping RLS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { requireAgencyClientOrg } from '@/lib/auth/active-org'
import { getGhlConfig } from '@/lib/ghl/client'
import { reconcileGhlStages } from '@/lib/ghl/reconcile'

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()
  const guard = await requireAgencyClientOrg(supabase)
  if ('error' in guard) return guard.error
  const { orgId } = guard

  const service = createServiceClient()
  const config = await getGhlConfig(service, orgId)
  if (!config) {
    return NextResponse.json(
      { error: 'GoHighLevel is not configured or is disabled for this practice.' },
      { status: 400 },
    )
  }

  // GHL authority only — mirror the cron guard. reconcileGhlStages is a
  // GHL-authoritative overwrite: it moves stage_id and writes declined/opt_out
  // from GHL's DND columns. For an LI-authority practice that would stomp
  // manually-advanced leads (e.g. a booked lead yanked back to a stale GHL stage
  // and marked SMS-declined). Refuse rather than run.
  if (config.stageAuthority !== 'ghl') {
    return NextResponse.json(
      { error: 'This practice runs pipeline stages in Lead Intelligence (not GHL-authoritative), so manual GHL sync is disabled to avoid overwriting LI-owned stages.' },
      { status: 400 },
    )
  }

  try {
    const result = await reconcileGhlStages(service, orgId, config)
    return NextResponse.json({ result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'sync_failed' },
      { status: 500 },
    )
  }
}
