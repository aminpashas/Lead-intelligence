/**
 * Windsor.ai sync runner.
 *
 * For each enabled data_source, pull the date range [last_synced_date - LOOKBACK_DAYS, today]
 * from Windsor and upsert into ad_spend_daily. We use a lookback (vs strict cursor) because:
 *   - Ad platforms backfill spend for ~3 days as conversions are attributed
 *   - Campaign-level metrics get restated when ad-platform algorithms reconcile
 *
 * Idempotency: ad_spend_daily has a unique index on
 * (org, date, platform, coalesce(campaign_id,''), coalesce(ad_group_id,''))
 * so re-pulling the same date overwrites stale numbers.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchWindsorSpend, type WindsorConfig, type WindsorSpendRow } from './client'

const LOOKBACK_DAYS = 7      // re-pull last week each run to catch backfills + restatements
const MAX_BACKFILL_DAYS = 90 // first run for a fresh org goes back this far

export type WindsorRunResult = {
  source: string
  date_from: string
  date_to: string
  rows_fetched: number
  rows_upserted: number
  status: 'success' | 'failed'
  error?: string
}

export async function runWindsorSync(
  supabase: SupabaseClient,
  organizationId: string,
  config: WindsorConfig
): Promise<WindsorRunResult[]> {
  const today = isoDate(new Date())

  // Determine the date range to pull.
  const { data: state } = await supabase
    .from('windsor_sync_state')
    .select('last_synced_date')
    .eq('organization_id', organizationId)
    .maybeSingle()

  const lastSynced = state?.last_synced_date as string | undefined
  const dateFrom = lastSynced
    ? isoDate(new Date(new Date(lastSynced).getTime() - LOOKBACK_DAYS * 86400_000))
    : isoDate(new Date(Date.now() - MAX_BACKFILL_DAYS * 86400_000))
  const dateTo = today

  const results: WindsorRunResult[] = []
  let totalRowsUpserted = 0

  for (const source of config.data_sources) {
    let rows: WindsorSpendRow[] = []
    try {
      rows = await fetchWindsorSpend(config, source, dateFrom, dateTo)
    } catch (err) {
      results.push({
        source,
        date_from: dateFrom,
        date_to: dateTo,
        rows_fetched: 0,
        rows_upserted: 0,
        status: 'failed',
        error: err instanceof Error ? err.message : 'unknown',
      })
      continue
    }

    let upserted = 0
    // Upsert in chunks of 500 to keep the Supabase request payload small.
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => ({
        organization_id: organizationId,
        date: r.date,
        platform: r.platform,
        account_id: r.account_id,
        account_name: r.account_name,
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        ad_group_id: r.ad_group_id,
        ad_group_name: r.ad_group_name,
        spend: r.spend,
        impressions: r.impressions,
        clicks: r.clicks,
        conversions: r.conversions,
        conversion_value: r.conversion_value,
        cpc: r.clicks > 0 ? Math.round((r.spend / r.clicks) * 10000) / 10000 : null,
        cpm: r.impressions > 0 ? Math.round((r.spend / r.impressions * 1000) * 10000) / 10000 : null,
        ctr: r.impressions > 0 ? Math.round((r.clicks / r.impressions) * 10000) / 10000 : null,
        metadata: r.metadata,
      }))

      const { error } = await supabase
        .from('ad_spend_daily')
        // The unique index includes coalesce() expressions, so use upsert with onConflict
        // listing the actual column names; PostgREST will use the matching unique constraint.
        .upsert(chunk, {
          onConflict: 'organization_id,date,platform,campaign_id,ad_group_id',
          ignoreDuplicates: false,
        })

      if (!error) {
        upserted += chunk.length
        totalRowsUpserted += chunk.length
      }
    }

    results.push({
      source,
      date_from: dateFrom,
      date_to: dateTo,
      rows_fetched: rows.length,
      rows_upserted: upserted,
      status: 'success',
    })
  }

  // Advance cursor to today only if at least one source succeeded.
  const anySuccess = results.some((r) => r.status === 'success')
  if (anySuccess) {
    await supabase
      .from('windsor_sync_state')
      .upsert(
        {
          organization_id: organizationId,
          last_synced_date: today,
          last_run_at: new Date().toISOString(),
          last_run_status: results.every((r) => r.status === 'success') ? 'success' : 'partial',
          last_run_rows: totalRowsUpserted,
        },
        { onConflict: 'organization_id' }
      )
  } else {
    await supabase
      .from('windsor_sync_state')
      .upsert(
        {
          organization_id: organizationId,
          last_run_at: new Date().toISOString(),
          last_run_status: 'failed',
          last_run_error: results.map((r) => `${r.source}: ${r.error}`).join('; '),
        },
        { onConflict: 'organization_id' }
      )
  }

  return results
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
