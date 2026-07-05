/**
 * GET /api/cron/sync-growth-studio-metrics
 *
 * Pulls per-campaign, per-day paid ad metrics from Dion Growth Studio (which
 * owns the Google Ads / Meta connectors) into LI's `ad_metrics_daily`, so the
 * agents' follow-up logic can weigh campaign health locally without a live
 * dependency on DGS.
 *
 * Why this cron and not /api/cron/sync-ad-metrics: that cron pulls straight
 * from Google/Meta/GA4 API connectors in LI's own `connector_configs` — but
 * those credentials live in DGS, not LI, so it always no-ops here. DGS already
 * pulls and stores the metrics; this cron mirrors them across the existing
 * DGS→LI bridge instead of standing up a duplicate set of ad-API integrations.
 *
 * Transport: HTTP pull via the GROWTH_STUDIO_BASE_URL bridge (same key as the
 * /api/v1/performance rollup). See src/lib/bridges/growth-studio-metrics.ts.
 *
 * Schedule: hourly (vercel.json). DGS metrics_daily refreshes a few times a
 * day and Google/Meta backfill conversions for several days after the click,
 * so each run re-pulls a rolling window and upserts (idempotent). Heartbeats to
 * cron_runs via withCron.
 */

import { withCron } from '@/lib/cron/with-cron'
import { createServiceClient } from '@/lib/supabase/server'
import {
  fetchGrowthStudioAdMetrics,
  type AdMetricsChannel,
  type GrowthStudioAdMetricRow,
} from '@/lib/bridges/growth-studio-metrics'

// Rolling window re-pulled each run. Covers late conversion backfill from both
// platforms while keeping the payload small enough for an hourly cron.
const LOOKBACK_DAYS = 30
const UPSERT_BATCH = 500

type ServiceClient = ReturnType<typeof createServiceClient>

export const POST = withCron('sync-growth-studio-metrics', async ({ supabase }) => {
  const rows = await fetchGrowthStudioAdMetrics({ days: LOOKBACK_DAYS })

  // null => bridge unconfigured or unreachable. Treat as a healthy no-op so a
  // DGS outage can't turn this cron red; the next run retries.
  if (rows === null) {
    return { status: 'skipped', items: 0, data: { reason: 'bridge_unavailable' } }
  }
  if (rows.length === 0) {
    return { status: 'ok', items: 0, data: { reason: 'no_rows' } }
  }

  // Only upsert rows for orgs that actually exist in LI — a stale
  // lead_intel_customer_id on the DGS side would otherwise fail the FK and
  // abort the whole batch.
  const orgIds = Array.from(new Set(rows.map((r) => r.customer_id)))
  const { data: orgs } = await supabase.from('organizations').select('id').in('id', orgIds)
  const knownOrgs = new Set(((orgs ?? []) as { id: string }[]).map((o) => o.id))

  const known: GrowthStudioAdMetricRow[] = []
  let droppedUnknownOrg = 0
  for (const r of rows) {
    if (knownOrgs.has(r.customer_id)) known.push(r)
    else droppedUnknownOrg++
  }

  const nowIso = new Date().toISOString()
  const records = known.map((r) => ({
    organization_id: r.customer_id,
    channel: r.channel,
    account_id: r.account_id,
    campaign_id: r.campaign_id,
    campaign_name: r.campaign_name,
    metric_date: r.metric_date,
    impressions: r.impressions,
    clicks: r.clicks,
    spend: r.spend,
    conversions: r.conversions,
    conversion_value: r.conversion_value,
    currency: r.currency,
    synced_at: nowIso,
  }))

  let upserted = 0
  let upsertError: string | null = null
  for (let i = 0; i < records.length && !upsertError; i += UPSERT_BATCH) {
    const batch = records.slice(i, i + UPSERT_BATCH)
    const { error } = await supabase
      .from('ad_metrics_daily')
      .upsert(batch, {
        onConflict: 'organization_id,channel,account_id,campaign_id,metric_date',
      })
    if (error) upsertError = error.message
    else upserted += batch.length
  }

  // Record one sync-state row per (org, channel) touched, preserving
  // last_success_at across a failed run — mirrors /api/cron/sync-ad-metrics.
  const pairs = new Map<string, { org: string; channel: AdMetricsChannel; rows: number }>()
  for (const r of known) {
    const k = `${r.customer_id}:${r.channel}`
    const cur = pairs.get(k) ?? { org: r.customer_id, channel: r.channel, rows: 0 }
    cur.rows++
    pairs.set(k, cur)
  }
  for (const p of pairs.values()) {
    await recordSyncState(supabase, p.org, p.channel, upsertError ? 0 : p.rows, upsertError)
  }

  if (upsertError) throw new Error(`ad_metrics_daily upsert failed: ${upsertError}`)

  return {
    items: upserted,
    data: {
      rows_upserted: upserted,
      orgs: pairs.size ? new Set([...pairs.values()].map((p) => p.org)).size : 0,
      dropped_unknown_org: droppedUnknownOrg,
    },
  }
})

export const GET = POST

async function recordSyncState(
  supabase: ServiceClient,
  organizationId: string,
  channel: AdMetricsChannel,
  rowsInserted: number,
  error: string | null,
): Promise<void> {
  const now = new Date().toISOString()
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
    { onConflict: 'organization_id,channel' },
  )
}
