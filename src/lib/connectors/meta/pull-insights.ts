/**
 * Meta — daily ad-account campaign insights pull.
 *
 * Uses the Marketing API `/{ad_account_id}/insights` endpoint with
 * `time_increment=1` to get day-level rows, grouped by campaign. The
 * connecting user's long-lived access token is per-org (60-day expiry,
 * encrypted at rest in connector_configs.credentials).
 *
 * Like Google, we pull a rolling 14-day window each run because Meta
 * backfills attribution for several days after the click.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const META_API_VERSION = 'v19.0'
const META_GRAPH_BASE = `https://graph.facebook.com/${META_API_VERSION}`

export type MetaPullConfig = {
  adAccountId: string                // 'act_...' form
  accessToken: string                // long-lived user access token
}

export type PullResult = {
  rowsUpserted: number
  daysFetched: number
  error?: string
}

export async function pullMetaInsights(
  supabase: SupabaseClient,
  organizationId: string,
  config: MetaPullConfig,
  options: { lookbackDays?: number } = {}
): Promise<PullResult> {
  const lookback = options.lookbackDays ?? 14
  const since = ymd(addDays(new Date(), -lookback))
  const until = ymd(new Date())

  // The /insights endpoint paginates — we follow `paging.next` until it
  // disappears. Asking for `actions` + `action_values` includes the
  // platform's pixel-attributed conversions and revenue.
  const fields = [
    'campaign_id',
    'campaign_name',
    'date_start',
    'impressions',
    'clicks',
    'spend',
    'actions',
    'action_values',
    'account_currency',
  ].join(',')

  const initialParams = new URLSearchParams({
    access_token: config.accessToken,
    level: 'campaign',
    time_increment: '1',
    time_range: JSON.stringify({ since, until }),
    fields,
    limit: '500',
  })

  let url = `${META_GRAPH_BASE}/${config.adAccountId}/insights?${initialParams.toString()}`
  const allRows: Array<Record<string, unknown>> = []

  // Cap pagination loops defensively. 30-day window × max ~200 campaigns
  // × paging shouldn't exceed a handful of pages, but a malformed cursor
  // shouldn't trap us in an infinite fetch.
  for (let page = 0; page < 50; page++) {
    const res = await fetch(url)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        rowsUpserted: allRows.length,
        daysFetched: lookback,
        error: `meta_${res.status}: ${text.slice(0, 300)}`,
      }
    }
    const body = (await res.json()) as {
      data?: Array<{
        campaign_id?: string
        campaign_name?: string
        date_start?: string
        impressions?: string
        clicks?: string
        spend?: string
        actions?: Array<{ action_type: string; value: string }>
        action_values?: Array<{ action_type: string; value: string }>
        account_currency?: string
      }>
      paging?: { next?: string }
    }

    for (const r of body.data || []) {
      if (!r.campaign_id || !r.date_start) continue

      // Roll up "conversion-like" actions to a single number. Meta exposes
      // dozens of action types; the closest analog to Google's
      // metrics.conversions is the sum of pixel-driven lead/purchase/
      // initiate-checkout actions. The picker stored a Pixel ID per org
      // but insights returns aggregates by ad-account, so we sum the
      // action types Meta canonically maps to "conversions" in Ads Manager.
      const conversions = sumActions(r.actions, CONVERSION_ACTION_TYPES)
      const conversionValue = sumActions(r.action_values, CONVERSION_ACTION_TYPES)

      allRows.push({
        organization_id: organizationId,
        channel: 'meta',
        account_id: config.adAccountId,
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name || null,
        metric_date: r.date_start,
        impressions: Number(r.impressions || 0),
        clicks: Number(r.clicks || 0),
        spend: Number(r.spend || 0),
        conversions,
        conversion_value: conversionValue,
        currency: r.account_currency || null,
        synced_at: new Date().toISOString(),
      })
    }

    if (!body.paging?.next) break
    url = body.paging.next
  }

  if (allRows.length === 0) {
    return { rowsUpserted: 0, daysFetched: lookback }
  }

  let upserted = 0
  for (const batch of chunked(allRows, 500)) {
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

// The action types Meta groups under "conversions" in Ads Manager.
// Source: developers.facebook.com/docs/marketing-api/insights/breakdowns
// (lead, purchase, complete_registration, schedule, contact, submit_application).
// Adjust per org policy if a different conversion definition is used.
const CONVERSION_ACTION_TYPES = new Set([
  'lead',
  'purchase',
  'offsite_conversion.fb_pixel_lead',
  'offsite_conversion.fb_pixel_purchase',
  'offsite_conversion.fb_pixel_complete_registration',
  'offsite_conversion.fb_pixel_schedule',
  'offsite_conversion.fb_pixel_contact',
  'offsite_conversion.fb_pixel_submit_application',
])

function sumActions(
  actions: Array<{ action_type: string; value: string }> | undefined,
  matchSet: Set<string>
): number {
  if (!actions) return 0
  let sum = 0
  for (const a of actions) {
    if (matchSet.has(a.action_type)) sum += Number(a.value || 0)
  }
  return sum
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
