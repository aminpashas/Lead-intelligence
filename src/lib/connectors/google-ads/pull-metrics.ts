/**
 * Google Ads — daily campaign metrics pull.
 *
 * Uses the Google Ads API `searchStream` endpoint with a GAQL query
 * grouped by campaign + date. We pull a rolling 14-day window each run
 * because Google backfills conversions for several days after the click
 * (Smart Bidding's attribution latency). Persisted into
 * `ad_metrics_daily` keyed on (org, channel='google_ads', account_id,
 * campaign_id, metric_date).
 *
 * Auth: per-org refresh token from connector_configs.credentials, plus
 * platform-wide developer token from env.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { refreshGoogleAccessToken } from '@/lib/connectors/oauth/google'

const GOOGLE_ADS_API_VERSION = 'v18'
const GOOGLE_ADS_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`

export type GoogleAdsPullConfig = {
  customerId: string                 // bare digits, no dashes
  refreshToken: string
  loginCustomerId?: string           // MCC if applicable
  developerToken: string
}

export type PullResult = {
  rowsUpserted: number
  daysFetched: number
  error?: string
}

/**
 * Pull a rolling N-day window (default 14) of campaign-level metrics
 * and upsert into ad_metrics_daily.
 */
export async function pullGoogleAdsMetrics(
  supabase: SupabaseClient,
  organizationId: string,
  config: GoogleAdsPullConfig,
  options: { lookbackDays?: number } = {}
): Promise<PullResult> {
  const lookback = options.lookbackDays ?? 14

  let accessToken: string
  try {
    const t = await refreshGoogleAccessToken(config.refreshToken)
    accessToken = t.accessToken
  } catch (err) {
    return {
      rowsUpserted: 0,
      daysFetched: 0,
      error: `oauth_refresh_failed: ${err instanceof Error ? err.message : 'unknown'}`,
    }
  }

  // GAQL query — campaign-level, grouped by date. We include
  // metrics.conversions_value (revenue per Google Ads attribution) and
  // currency from the parent customer row so the spend column is
  // self-describing.
  const startDate = ymd(addDays(new Date(), -lookback))
  const endDate = ymd(new Date())

  const query = `
    SELECT
      campaign.id,
      campaign.name,
      segments.date,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      customer.currency_code
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
  `.trim()

  const url = `${GOOGLE_ADS_BASE}/customers/${config.customerId}/googleAds:searchStream`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': config.developerToken,
      'content-type': 'application/json',
      ...(config.loginCustomerId ? { 'login-customer-id': config.loginCustomerId } : {}),
    },
    body: JSON.stringify({ query }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return {
      rowsUpserted: 0,
      daysFetched: 0,
      error: `google_ads_${res.status}: ${text.slice(0, 300)}`,
    }
  }

  // searchStream returns a JSON array of result chunks.
  const chunks = (await res.json()) as Array<{
    results?: Array<{
      campaign?: { id?: string; name?: string }
      segments?: { date?: string }
      metrics?: {
        impressions?: string
        clicks?: string
        costMicros?: string
        conversions?: number
        conversionsValue?: number
      }
      customer?: { currencyCode?: string }
    }>
  }>

  const rows: Array<Record<string, unknown>> = []
  for (const chunk of chunks) {
    for (const r of chunk.results || []) {
      const campaignId = r.campaign?.id
      const date = r.segments?.date
      if (!campaignId || !date) continue
      rows.push({
        organization_id: organizationId,
        channel: 'google_ads',
        account_id: config.customerId,
        campaign_id: campaignId,
        campaign_name: r.campaign?.name || null,
        metric_date: date,
        impressions: Number(r.metrics?.impressions || 0),
        clicks: Number(r.metrics?.clicks || 0),
        // cost_micros is the spend in millionths of the account currency.
        spend: Number(r.metrics?.costMicros || 0) / 1_000_000,
        conversions: r.metrics?.conversions || 0,
        conversion_value: r.metrics?.conversionsValue || 0,
        currency: r.customer?.currencyCode || null,
        synced_at: new Date().toISOString(),
      })
    }
  }

  if (rows.length === 0) {
    return { rowsUpserted: 0, daysFetched: lookback }
  }

  // Upsert in batches to stay under Postgres parameter limits.
  let upserted = 0
  for (const batch of chunked(rows, 500)) {
    const { error } = await supabase
      .from('ad_metrics_daily')
      .upsert(batch, { onConflict: 'organization_id,channel,account_id,campaign_id,metric_date' })
    if (error) {
      return {
        rowsUpserted: upserted,
        daysFetched: lookback,
        error: `upsert_failed: ${error.message}`,
      }
    }
    upserted += batch.length
  }

  return { rowsUpserted: upserted, daysFetched: lookback }
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}
function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setUTCDate(out.getUTCDate() + n)
  return out
}
function* chunked<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size)
}
