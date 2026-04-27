/**
 * GET /api/cron/sync-ad-metrics
 *
 * Daily orchestrator that pulls fresh ad-platform metrics into
 * `ad_metrics_daily`. For each org with an enabled Google Ads, GA4, or
 * Meta connector, it calls the matching pull module with a 14-day
 * rolling window and records sync state.
 *
 * Auth: Bearer CRON_SECRET (matches the existing /api/cron/* convention).
 *
 * Schedule: 03:00 UTC daily (vercel.json). Pulls always cover a 14-day
 * window so day-of-conversion backfill from Google + Meta is captured.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { decryptCredentials } from '@/lib/connectors/crypto'
import { pullGoogleAdsMetrics } from '@/lib/connectors/google-ads/pull-metrics'
import { pullGA4Metrics } from '@/lib/connectors/ga4/pull-metrics'
import { pullMetaInsights } from '@/lib/connectors/meta/pull-insights'

const LOOKBACK_DAYS = 14

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  // Pull every enabled connector in one query. We filter to the channels
  // we have pull modules for; google_reviews / outbound_webhook / slack /
  // callrail are push-only.
  const { data: configs } = await supabase
    .from('connector_configs')
    .select('organization_id, connector_type, credentials, settings')
    .in('connector_type', ['google_ads', 'ga4', 'meta_capi'])
    .eq('enabled', true)

  if (!configs || configs.length === 0) {
    return NextResponse.json({ message: 'no_connectors_configured', synced: 0 })
  }

  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN

  type RunResult = {
    organization_id: string
    channel: 'google_ads' | 'ga4' | 'meta'
    rowsUpserted: number
    error?: string
  }
  const results: RunResult[] = []

  for (const cfg of configs) {
    const orgId = cfg.organization_id as string
    const creds = decryptCredentials(cfg.credentials as Record<string, unknown>)
    const settings = (cfg.settings || {}) as Record<string, unknown>

    if (cfg.connector_type === 'google_ads') {
      const customerId = (creds as { customerId?: string }).customerId
      const refreshToken = (creds as { refreshToken?: string }).refreshToken
      if (!customerId || !refreshToken || !developerToken) {
        results.push({
          organization_id: orgId,
          channel: 'google_ads',
          rowsUpserted: 0,
          error: 'missing_required_credentials',
        })
        await recordSyncState(supabase, orgId, 'google_ads', 0, 'missing_required_credentials')
        continue
      }
      const r = await pullGoogleAdsMetrics(
        supabase,
        orgId,
        {
          customerId,
          refreshToken,
          loginCustomerId: (creds as { loginCustomerId?: string }).loginCustomerId,
          developerToken,
        },
        { lookbackDays: LOOKBACK_DAYS }
      )
      results.push({ organization_id: orgId, channel: 'google_ads', ...r })
      await recordSyncState(supabase, orgId, 'google_ads', r.rowsUpserted, r.error || null)
    } else if (cfg.connector_type === 'ga4') {
      // propertyId comes from settings (public identifier) or credentials
      // depending on which path wrote the row. Manual form puts it in
      // credentials.measurementId etc.; OAuth select stores propertyId
      // in settings.property_id.
      const propertyId =
        (settings.property_id as string | undefined) ||
        (creds as { propertyId?: string }).propertyId
      const refreshToken = (creds as { refreshToken?: string }).refreshToken
      if (!propertyId || !refreshToken) {
        results.push({
          organization_id: orgId,
          channel: 'ga4',
          rowsUpserted: 0,
          error: 'missing_required_credentials',
        })
        await recordSyncState(supabase, orgId, 'ga4', 0, 'missing_required_credentials')
        continue
      }
      const r = await pullGA4Metrics(
        supabase,
        orgId,
        { propertyId, refreshToken },
        { lookbackDays: LOOKBACK_DAYS }
      )
      results.push({ organization_id: orgId, channel: 'ga4', ...r })
      await recordSyncState(supabase, orgId, 'ga4', r.rowsUpserted, r.error || null)
    } else if (cfg.connector_type === 'meta_capi') {
      const adAccountId =
        (settings.ad_account_id as string | undefined) ||
        (creds as { adAccountId?: string }).adAccountId
      const accessToken = (creds as { accessToken?: string }).accessToken
      if (!adAccountId || !accessToken) {
        results.push({
          organization_id: orgId,
          channel: 'meta',
          rowsUpserted: 0,
          error: 'missing_required_credentials',
        })
        await recordSyncState(supabase, orgId, 'meta', 0, 'missing_required_credentials')
        continue
      }
      const r = await pullMetaInsights(
        supabase,
        orgId,
        { adAccountId, accessToken },
        { lookbackDays: LOOKBACK_DAYS }
      )
      results.push({ organization_id: orgId, channel: 'meta', ...r })
      await recordSyncState(supabase, orgId, 'meta', r.rowsUpserted, r.error || null)
    }
  }

  const totalRows = results.reduce((s, r) => s + r.rowsUpserted, 0)
  const failures = results.filter((r) => r.error).length
  return NextResponse.json({
    synced: results.length,
    total_rows: totalRows,
    failures,
    results,
  })
}

async function recordSyncState(
  supabase: ReturnType<typeof createServiceClient>,
  organizationId: string,
  channel: 'google_ads' | 'ga4' | 'meta',
  rowsInserted: number,
  error: string | null
): Promise<void> {
  const now = new Date().toISOString()
  // We preserve last_success_at on failed runs by reading the prior row
  // and carrying it forward — otherwise an upsert would null out the
  // successful sync timestamp on every transient failure.
  let preservedSuccess: string | null = null
  if (error) {
    const { data: prior } = await supabase
      .from('ad_metrics_sync_state')
      .select('last_success_at')
      .eq('organization_id', organizationId)
      .eq('channel', channel)
      .maybeSingle()
    preservedSuccess = (prior as { last_success_at?: string | null } | null)?.last_success_at ?? null
  }

  await supabase.from('ad_metrics_sync_state').upsert(
    {
      organization_id: organizationId,
      channel,
      last_synced_at: now,
      last_success_at: error ? preservedSuccess : now,
      last_error: error,
      rows_inserted_last_run: rowsInserted,
    },
    { onConflict: 'organization_id,channel' }
  )
}
