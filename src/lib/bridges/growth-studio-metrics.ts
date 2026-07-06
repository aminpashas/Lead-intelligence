/**
 * Campaign ad-metrics bridge — Dion Growth Studio → Lead Intelligence.
 *
 * DGS owns the Google Ads / Meta connectors and stores per-campaign, per-day
 * spend + conversions in its `metrics_daily` table. DGS is the source of truth
 * for ad data; LI does NOT warehouse a local copy. Instead the engine reads
 * from DGS live on demand — e.g. the command agent's get_campaign_performance
 * tool calls this to answer "how are Google/Meta doing?" so campaign health is
 * always current and there is one authoritative copy.
 *
 * It calls DGS's `/api/v1/ad-metrics` endpoint (the sibling of the
 * `/api/v1/performance` rollup already used by `bridges/growth-studio.ts`) and
 * returns normalized rows (channel mapped to google_ads/meta/ga4). Returns null
 * if the bridge isn't configured or is unreachable, so callers degrade cleanly.
 *
 * Env (Vercel only):
 *   GROWTH_STUDIO_BASE_URL — e.g. https://dion-growth-studio.vercel.app
 *   GROWTH_STUDIO_API_KEY  — equals dion-growth-studio's LEAD_INTELLIGENCE_SERVICE_KEY
 */

import { logger } from '@/lib/logger'

/** LI ad_metrics_daily.channel only permits these (migration 036 CHECK). */
export type AdMetricsChannel = 'google_ads' | 'meta' | 'ga4'

/**
 * One (customer, channel, account, campaign, date) row from DGS, already
 * mapped to LI's `ad_metrics_daily` shape. `customer_id` is the LI
 * organization_id (DGS keys workspaces on workspaces.lead_intel_customer_id,
 * which is 1:1 with LI organization_id).
 */
export interface GrowthStudioAdMetricRow {
  customer_id: string
  channel: AdMetricsChannel
  account_id: string
  campaign_id: string | null
  campaign_name: string | null
  metric_date: string // YYYY-MM-DD
  impressions: number
  clicks: number
  spend: number
  conversions: number
  conversion_value: number
  currency: string | null
}

interface AdMetricsResponse {
  rows: unknown[]
}

/** Map DGS channel codes to LI's ad_metrics_daily CHECK values. */
function normalizeChannel(raw: unknown): AdMetricsChannel | null {
  switch (raw) {
    case 'ppc_google':
    case 'google_ads':
      return 'google_ads'
    case 'ppc_meta':
    case 'meta':
      return 'meta'
    case 'ga4':
      return 'ga4'
    default:
      return null
  }
}

function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

/**
 * Coerce one raw endpoint row into a validated GrowthStudioAdMetricRow, or
 * null if it's missing the fields we require (customer_id, a mappable channel,
 * and a date). Defensive because the payload crosses a service boundary.
 */
function coerceRow(raw: unknown): GrowthStudioAdMetricRow | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const customerId = typeof r.customer_id === 'string' ? r.customer_id : null
  const channel = normalizeChannel(r.channel)
  const metricDate = typeof r.metric_date === 'string' ? r.metric_date.slice(0, 10) : null
  if (!customerId || !channel || !metricDate) return null

  // account_id is NOT NULL in ad_metrics_daily; synthesize a stable fallback.
  const accountId =
    typeof r.account_id === 'string' && r.account_id.length > 0 ? r.account_id : 'growth_studio'

  return {
    customer_id: customerId,
    channel,
    account_id: accountId,
    campaign_id: r.campaign_id != null ? String(r.campaign_id) : null,
    campaign_name: r.campaign_name != null ? String(r.campaign_name) : null,
    metric_date: metricDate,
    impressions: Math.trunc(toNumber(r.impressions)),
    clicks: Math.trunc(toNumber(r.clicks)),
    spend: toNumber(r.spend),
    conversions: toNumber(r.conversions),
    conversion_value: toNumber(r.conversion_value),
    currency: typeof r.currency === 'string' ? r.currency : 'USD',
  }
}

/**
 * Pull the last `days` of paid campaign metrics for every DGS workspace linked
 * to an LI org. Returns validated rows, or null when the bridge is unconfigured
 * or the call fails (so the caller no-ops cleanly).
 */
export async function fetchGrowthStudioAdMetrics(params: {
  days?: number
}): Promise<GrowthStudioAdMetricRow[] | null> {
  const base = process.env.GROWTH_STUDIO_BASE_URL
  const key = process.env.GROWTH_STUDIO_API_KEY
  if (!base || !key) return null

  const days = params.days ?? 90
  try {
    const res = await fetch(`${base}/api/v1/ad-metrics?days=${days}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      logger.warn('growth-studio ad-metrics bridge non-OK', { status: res.status })
      return null
    }
    const body = (await res.json()) as AdMetricsResponse
    if (!body || !Array.isArray(body.rows)) return null

    const rows: GrowthStudioAdMetricRow[] = []
    for (const raw of body.rows) {
      const row = coerceRow(raw)
      if (row) rows.push(row)
    }
    return rows
  } catch (err) {
    logger.warn('growth-studio ad-metrics bridge unreachable', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
