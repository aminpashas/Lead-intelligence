/**
 * GET /api/analytics/ad-spend
 *
 * Reads from ad_metrics_daily for the calling user's org and returns:
 *   - kpis: totals across the date range
 *   - byChannel: row-per-channel summary
 *   - byCampaign: row-per-campaign summary, sorted by spend desc
 *   - daily: time series for charting
 *   - syncStatus: per-channel last_synced_at + error
 *
 * The existing /api/analytics/attribution endpoint handles conversion
 * counts and revenue from the leads table — this one supplies the spend
 * side so the dashboard can compute true ROAS by joining on
 * (channel, campaign_name) at render time.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'

type Channel = 'google_ads' | 'meta' | 'ga4'

type MetricsRow = {
  channel: Channel
  account_id: string
  campaign_id: string | null
  campaign_name: string | null
  metric_date: string
  impressions: number
  clicks: number
  spend: number
  conversions: number
  conversion_value: number
  sessions: number | null
  users: number | null
  currency: string | null
}

export async function GET(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()
  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = request.nextUrl
  const startParam = url.searchParams.get('start_date')
  const endParam = url.searchParams.get('end_date')
  const channelParam = url.searchParams.get('channel') as Channel | null

  const endDate = endParam ? new Date(endParam) : new Date()
  const startDate = startParam ? new Date(startParam) : new Date(endDate.getTime() - 30 * 86400000)

  const startYmd = startDate.toISOString().slice(0, 10)
  const endYmd = endDate.toISOString().slice(0, 10)

  let query = supabase
    .from('ad_metrics_daily')
    .select('channel, account_id, campaign_id, campaign_name, metric_date, impressions, clicks, spend, conversions, conversion_value, sessions, users, currency')
    .eq('organization_id', profile.organization_id)
    .gte('metric_date', startYmd)
    .lte('metric_date', endYmd)
    .order('metric_date', { ascending: true })
    .limit(50_000)

  if (channelParam && ['google_ads', 'meta', 'ga4'].includes(channelParam)) {
    query = query.eq('channel', channelParam)
  }

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  const rows = (data || []) as MetricsRow[]

  // KPIs across the whole window. We collapse channels into one set of
  // numbers — the dashboard splits by channel in the byChannel block
  // below if it wants to show per-channel KPI cards.
  const kpis = {
    spend: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    conversion_value: 0,
    sessions: 0,
    users: 0,
  }
  const byChannelMap = new Map<Channel, typeof kpis>()
  const byCampaignMap = new Map<
    string,
    {
      key: string
      channel: Channel
      campaign_id: string | null
      campaign_name: string | null
      spend: number
      impressions: number
      clicks: number
      conversions: number
      conversion_value: number
      currency: string | null
    }
  >()
  const dailyMap = new Map<
    string,
    {
      date: string
      spend: number
      clicks: number
      impressions: number
      conversions: number
      conversion_value: number
      sessions: number
    }
  >()

  for (const r of rows) {
    kpis.spend += Number(r.spend || 0)
    kpis.impressions += Number(r.impressions || 0)
    kpis.clicks += Number(r.clicks || 0)
    kpis.conversions += Number(r.conversions || 0)
    kpis.conversion_value += Number(r.conversion_value || 0)
    kpis.sessions += Number(r.sessions || 0)
    kpis.users += Number(r.users || 0)

    let ch = byChannelMap.get(r.channel)
    if (!ch) {
      ch = { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversion_value: 0, sessions: 0, users: 0 }
      byChannelMap.set(r.channel, ch)
    }
    ch.spend += Number(r.spend || 0)
    ch.impressions += Number(r.impressions || 0)
    ch.clicks += Number(r.clicks || 0)
    ch.conversions += Number(r.conversions || 0)
    ch.conversion_value += Number(r.conversion_value || 0)
    ch.sessions += Number(r.sessions || 0)
    ch.users += Number(r.users || 0)

    const campaignKey = `${r.channel}::${r.campaign_id || ''}`
    let camp = byCampaignMap.get(campaignKey)
    if (!camp) {
      camp = {
        key: campaignKey,
        channel: r.channel,
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        conversion_value: 0,
        currency: r.currency,
      }
      byCampaignMap.set(campaignKey, camp)
    }
    camp.spend += Number(r.spend || 0)
    camp.impressions += Number(r.impressions || 0)
    camp.clicks += Number(r.clicks || 0)
    camp.conversions += Number(r.conversions || 0)
    camp.conversion_value += Number(r.conversion_value || 0)

    let day = dailyMap.get(r.metric_date)
    if (!day) {
      day = {
        date: r.metric_date,
        spend: 0,
        clicks: 0,
        impressions: 0,
        conversions: 0,
        conversion_value: 0,
        sessions: 0,
      }
      dailyMap.set(r.metric_date, day)
    }
    day.spend += Number(r.spend || 0)
    day.impressions += Number(r.impressions || 0)
    day.clicks += Number(r.clicks || 0)
    day.conversions += Number(r.conversions || 0)
    day.conversion_value += Number(r.conversion_value || 0)
    day.sessions += Number(r.sessions || 0)
  }

  // Sync state — surfaces "last synced 4 hours ago" + per-channel errors
  // in the dashboard so a stale or broken connector is visible.
  const { data: syncStateRows } = await supabase
    .from('ad_metrics_sync_state')
    .select('channel, last_synced_at, last_success_at, last_error, rows_inserted_last_run')
    .eq('organization_id', profile.organization_id)

  return NextResponse.json({
    range: { start: startYmd, end: endYmd },
    kpis,
    byChannel: Array.from(byChannelMap.entries()).map(([channel, totals]) => ({
      channel,
      ...totals,
    })),
    byCampaign: Array.from(byCampaignMap.values()).sort((a, b) => b.spend - a.spend),
    daily: Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
    syncStatus: syncStateRows || [],
  })
}
