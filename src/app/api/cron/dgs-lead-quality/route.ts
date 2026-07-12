/**
 * GET /api/cron/dgs-lead-quality
 *
 * Daily push of LI's behavior-derived lead quality back to Dion Growth Studio.
 * For every active org it builds the DgsFeedback payload (channel/campaign
 * scorecards + dgs-relevant recommendations, rolling 30-day window) and POSTs
 * it to DGS /api/v1/lead-quality via the lead-quality bridge.
 *
 * DGS replaces a re-pushed identical window, so the daily rolling window is
 * idempotent — no outbox or delivery ledger needed. Orgs DGS can't map to a
 * workspace (422) are recorded as unmapped and not retried; the whole run is a
 * healthy skip when the bridge env vars are absent (local dev, previews).
 *
 * Auth: Bearer CRON_SECRET via withCron. Schedule: 07:00 UTC daily
 * (vercel.json), after sync-ad-metrics (04:00) so spend joins are fresh.
 */

import { withCron } from '@/lib/cron/with-cron'
import { buildDgsFeedbackForOrg } from '@/lib/analytics/dgs-feedback'
import { pushLeadQualityFeedback } from '@/lib/bridges/growth-studio-lead-quality'

const WINDOW_DAYS = 30

export const GET = withCron('dgs-lead-quality', async ({ supabase }) => {
  if (!process.env.GROWTH_STUDIO_BASE_URL || !process.env.GROWTH_STUDIO_API_KEY) {
    return { status: 'skipped', data: { message: 'bridge_not_configured' } }
  }

  const { data: orgs } = await supabase
    .from('organizations')
    .select('id')
    .eq('subscription_status', 'active')

  if (!orgs || orgs.length === 0) {
    return { status: 'skipped', data: { message: 'no_active_organizations' } }
  }

  const end = new Date().toISOString()
  const start = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  type OrgResult = {
    organization_id: string
    status: 'pushed' | 'unmapped' | 'error'
    run_id?: string | null
    rows?: number
    error?: string
  }
  const results: OrgResult[] = []

  // Sequential on purpose: each org fans out 7 RPCs, and DGS is a single
  // downstream — a burst of parallel orgs buys little and risks timeouts.
  for (const org of orgs) {
    const orgId = org.id as string
    try {
      const feedback = await buildDgsFeedbackForOrg(supabase, orgId, { start, end })
      const pushed = await pushLeadQualityFeedback(feedback)
      if (pushed.status === 'pushed') {
        results.push({
          organization_id: orgId,
          status: 'pushed',
          run_id: pushed.runId,
          rows: pushed.rows,
        })
      } else if (pushed.status === 'unmapped') {
        results.push({ organization_id: orgId, status: 'unmapped' })
      } else if (pushed.status === 'error') {
        results.push({ organization_id: orgId, status: 'error', error: pushed.message })
      }
      // 'unconfigured' is unreachable here — env checked above.
    } catch (err) {
      results.push({
        organization_id: orgId,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const pushed = results.filter((r) => r.status === 'pushed').length
  const failures = results.filter((r) => r.status === 'error').length
  return {
    // Every push failing (with orgs mapped) is a soft failure worth surfacing
    // in cron health; unmapped-only runs are still ok — nothing to push yet.
    status: failures > 0 && pushed === 0 ? 'failed' : 'ok',
    items: pushed,
    data: {
      window: { start, end },
      orgs: results.length,
      pushed,
      unmapped: results.filter((r) => r.status === 'unmapped').length,
      failures,
      results,
    },
  }
})
