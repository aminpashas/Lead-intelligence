/**
 * GA4 — daily traffic + conversion metrics pull.
 *
 * Uses the GA4 Data API's `runReport` to pull session, user, and
 * conversion counts grouped by `date` × `sessionSource` ×
 * `sessionCampaignName`. We persist these into ad_metrics_daily under
 * channel='ga4' so the attribution dashboard can show traffic alongside
 * paid spend in one query.
 *
 * Auth: per-org refresh token from connector_configs.credentials. The
 * scope used in /connect is `analytics.readonly` which covers the Data
 * API for the connecting user's properties.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { refreshGoogleAccessToken } from '@/lib/connectors/oauth/google'

const GA4_DATA_API_BASE = 'https://analyticsdata.googleapis.com/v1beta'

export type GA4PullConfig = {
  propertyId: string                 // bare digits, no "properties/" prefix
  refreshToken: string
}

export type PullResult = {
  rowsUpserted: number
  daysFetched: number
  error?: string
}

export async function pullGA4Metrics(
  supabase: SupabaseClient,
  organizationId: string,
  config: GA4PullConfig,
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

  const url = `${GA4_DATA_API_BASE}/properties/${config.propertyId}:runReport`
  const startDate = `${lookback}daysAgo`
  const endDate = 'today'

  const reportBody = {
    dateRanges: [{ startDate, endDate }],
    // We use `sessionSource` + `sessionCampaignName` (not the
    // `firstUserCampaign...` variants) so the row matches the campaign
    // that drove the session, not the first-touch — this lines up with
    // how the spend tables roll up.
    dimensions: [
      { name: 'date' },
      { name: 'sessionSource' },
      { name: 'sessionCampaignName' },
    ],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'engagedSessions' },
      { name: 'conversions' },
      { name: 'totalRevenue' },
    ],
    limit: 100_000,
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(reportBody),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return {
      rowsUpserted: 0,
      daysFetched: 0,
      error: `ga4_${res.status}: ${text.slice(0, 300)}`,
    }
  }

  const body = (await res.json()) as {
    rows?: Array<{
      dimensionValues?: Array<{ value: string }>
      metricValues?: Array<{ value: string }>
    }>
  }

  const rows: Array<Record<string, unknown>> = []
  for (const r of body.rows || []) {
    // GA4 returns `date` as 'YYYYMMDD'. Reformat to ISO 'YYYY-MM-DD'.
    const yyyymmdd = r.dimensionValues?.[0]?.value || ''
    if (yyyymmdd.length !== 8) continue
    const metricDate = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`

    const source = r.dimensionValues?.[1]?.value || ''
    const campaign = r.dimensionValues?.[2]?.value || ''

    // Synthesize a stable campaign_id from source+campaign so the unique
    // constraint groups consistently. GA4 doesn't expose Google Ads
    // campaign IDs through the Data API — joining to ad spend in the
    // dashboard happens on (campaign_name) instead, with the spend
    // table's campaign_id as the canonical key.
    const campaignKey = `${source}__${campaign || '(no campaign)'}`

    rows.push({
      organization_id: organizationId,
      channel: 'ga4',
      account_id: config.propertyId,
      campaign_id: campaignKey,
      campaign_name: campaign || null,
      metric_date: metricDate,
      impressions: 0,
      clicks: 0,
      spend: 0,
      conversions: Number(r.metricValues?.[3]?.value || 0),
      conversion_value: Number(r.metricValues?.[4]?.value || 0),
      sessions: Number(r.metricValues?.[0]?.value || 0),
      users: Number(r.metricValues?.[1]?.value || 0),
      engaged_sessions: Number(r.metricValues?.[2]?.value || 0),
      currency: null,
      synced_at: new Date().toISOString(),
    })
  }

  if (rows.length === 0) {
    return { rowsUpserted: 0, daysFetched: lookback }
  }

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

function* chunked<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size)
}
