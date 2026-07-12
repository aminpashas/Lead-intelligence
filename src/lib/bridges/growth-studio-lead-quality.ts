/**
 * Lead-quality feedback bridge — Lead Intelligence → Dion Growth Studio.
 *
 * The inverse of `growth-studio-metrics.ts`: where that pulls ad spend FROM
 * DGS, this pushes LI's behavior-derived campaign quality (channel/campaign
 * scorecards + dgs-relevant recommendations) TO DGS so ad optimization can
 * key on real lead quality instead of platform conversions.
 *
 * POSTs a DgsFeedback payload to DGS `/api/v1/lead-quality`. DGS resolves the
 * org via workspaces.lead_intel_customer_id and replaces any previously pushed
 * identical window, so re-pushing the same rolling window daily is idempotent.
 * A 422 means the org has no DGS workspace mapping — permanent until someone
 * maps it, so callers must record it as skipped, not retry.
 *
 * Env (Vercel only) — shared with the metrics bridge:
 *   GROWTH_STUDIO_BASE_URL — e.g. https://dion-growth-studio.vercel.app
 *   GROWTH_STUDIO_API_KEY  — equals dion-growth-studio's LEAD_INTELLIGENCE_SERVICE_KEY
 */

import { logger } from '@/lib/logger'
import type { DgsFeedback } from '@/lib/analytics/deep-types'

export type LeadQualityPushResult =
  | { status: 'pushed'; runId: string | null; rows: number }
  /** Bridge env vars absent — healthy no-op (e.g. local dev). */
  | { status: 'unconfigured' }
  /** DGS 422: org has no lead_intel_customer_id mapping. Do not retry. */
  | { status: 'unmapped' }
  | { status: 'error'; message: string }

export async function pushLeadQualityFeedback(
  feedback: DgsFeedback
): Promise<LeadQualityPushResult> {
  const base = process.env.GROWTH_STUDIO_BASE_URL
  const key = process.env.GROWTH_STUDIO_API_KEY
  if (!base || !key) return { status: 'unconfigured' }

  try {
    const res = await fetch(`${base}/api/v1/lead-quality`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(feedback),
      signal: AbortSignal.timeout(30_000),
    })

    if (res.status === 422) return { status: 'unmapped' }
    if (!res.ok) {
      logger.warn('growth-studio lead-quality push non-OK', {
        status: res.status,
        org_id: feedback.org_id,
      })
      return { status: 'error', message: `dgs_http_${res.status}` }
    }

    const body = (await res.json().catch(() => null)) as {
      run_id?: string
      rows?: number
    } | null
    return {
      status: 'pushed',
      runId: body?.run_id ?? null,
      rows: typeof body?.rows === 'number' ? body.rows : 0,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('growth-studio lead-quality push unreachable', {
      error: message,
      org_id: feedback.org_id,
    })
    return { status: 'error', message }
  }
}
