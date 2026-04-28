/**
 * Windsor.ai client — daily ad spend ingestion.
 *
 * Windsor.ai is a marketing data aggregator: it ingests from Google Ads, Meta Ads,
 * TikTok, etc., and exposes a unified REST API. We poll it daily to populate
 * ad_spend_daily, which we JOIN against our leads table for per-campaign CAC.
 *
 * API: GET https://connectors.windsor.ai/all?api_key=<key>&fields=<csv>&date_from=<iso>&date_to=<iso>&data_source=<source>
 *
 * Per-org config in connector_configs (connector_type='windsor'):
 *   credentials.api_key       — Windsor API key
 *   settings.data_sources     — array of windsor source slugs to pull (e.g. ['adwords','facebook'])
 *   settings.account_ids      — optional per-source account_id filters (most users have 1 of each)
 *
 * @see https://windsor.ai/api-fields/
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const WINDSOR_API_BASE = 'https://connectors.windsor.ai'

// Map Windsor data_source values → our normalized platform enum.
// Windsor uses their own slugs: 'adwords' for Google Ads, 'facebook' for Meta, etc.
const SOURCE_TO_PLATFORM: Record<string, AdPlatform> = {
  adwords: 'google_ads',
  google_ads: 'google_ads',
  facebook: 'meta_ads',
  meta: 'meta_ads',
  meta_ads: 'meta_ads',
  tiktok: 'tiktok_ads',
  tiktok_ads: 'tiktok_ads',
  youtube: 'youtube_ads',
  linkedin: 'linkedin_ads',
}

export type AdPlatform = 'google_ads' | 'meta_ads' | 'tiktok_ads' | 'youtube_ads' | 'linkedin_ads' | 'other'

export type WindsorConfig = {
  api_key: string
  data_sources: string[]                    // e.g. ['adwords', 'facebook']
  account_ids?: Record<string, string>      // per-source filter, e.g. { adwords: '123-456-7890' }
}

export type WindsorSpendRow = {
  date: string                              // YYYY-MM-DD
  platform: AdPlatform
  account_id: string | null
  account_name: string | null
  campaign_id: string | null
  campaign_name: string | null
  ad_group_id: string | null
  ad_group_name: string | null
  spend: number
  impressions: number
  clicks: number
  conversions: number | null
  conversion_value: number | null
  metadata: Record<string, unknown>
}

export async function getWindsorConfig(
  supabase: SupabaseClient,
  organizationId: string
): Promise<WindsorConfig | null> {
  const { data } = await supabase
    .from('connector_configs')
    .select('credentials, settings, enabled')
    .eq('organization_id', organizationId)
    .eq('connector_type', 'windsor')
    .single()

  if (!data || !data.enabled) return null

  const { decryptCredentials } = await import('@/lib/connectors/crypto')
  const creds = decryptCredentials(data.credentials as Record<string, unknown>) as Partial<WindsorConfig>
  const settings = (data.settings || {}) as Partial<WindsorConfig>

  if (!creds.api_key) return null

  return {
    api_key: creds.api_key,
    data_sources: settings.data_sources || ['adwords', 'facebook'],
    account_ids: settings.account_ids,
  }
}

/**
 * Fetch ad spend rows from Windsor for one source, normalized into our schema.
 *
 * Windsor's `/all` endpoint returns one row per (date, account, campaign, ad_group),
 * with field names mirroring the source platform (Google Ads vs Meta have slightly
 * different column names). We normalize via tolerant field extraction.
 */
export async function fetchWindsorSpend(
  config: WindsorConfig,
  source: string,
  dateFrom: string,
  dateTo: string
): Promise<WindsorSpendRow[]> {
  // Request a superset of fields we care about. Windsor silently drops fields
  // a given source doesn't have — we still benefit because one config works for all sources.
  const fields = [
    'date',
    'datasource',
    'account_id', 'account_name',
    'campaign_id', 'campaign', 'campaign_name',
    'adgroup_id', 'adgroup', 'adset_id', 'adset_name',
    'spend', 'cost',
    'impressions',
    'clicks',
    'conversions', 'all_conversions', 'leads',
    'conversion_value', 'all_conversion_value', 'revenue',
  ].join(',')

  const url = new URL(`${WINDSOR_API_BASE}/all`)
  url.searchParams.set('api_key', config.api_key)
  url.searchParams.set('data_source', source)
  url.searchParams.set('date_from', dateFrom)
  url.searchParams.set('date_to', dateTo)
  url.searchParams.set('fields', fields)
  url.searchParams.set('date_preset', 'custom')
  if (config.account_ids?.[source]) {
    url.searchParams.set('account_id', config.account_ids[source])
  }

  const res = await fetch(url.toString())
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Windsor ${res.status} (${source}): ${text.slice(0, 300)}`)
  }

  const json = await res.json() as { data?: Record<string, unknown>[] } | Record<string, unknown>[]
  const rows = Array.isArray(json) ? json : (json.data || [])

  const platform = SOURCE_TO_PLATFORM[source] || 'other'

  return rows.map((r) => normalizeRow(r, platform))
}

function normalizeRow(r: Record<string, unknown>, platform: AdPlatform): WindsorSpendRow {
  const num = (v: unknown): number => {
    if (typeof v === 'number') return v
    if (typeof v === 'string') {
      const parsed = Number(v)
      return isNaN(parsed) ? 0 : parsed
    }
    return 0
  }
  const str = (v: unknown): string | null => {
    if (v === null || v === undefined) return null
    return String(v)
  }
  // Windsor field aliases — different sources use different names for the same concept.
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (r[k] !== undefined && r[k] !== null && r[k] !== '') return r[k]
    }
    return undefined
  }

  const dateRaw = pick('date', 'day', 'date_start')
  const date = dateRaw ? String(dateRaw).slice(0, 10) : new Date().toISOString().slice(0, 10)

  return {
    date,
    platform,
    account_id: str(pick('account_id', 'account')),
    account_name: str(pick('account_name', 'account')),
    campaign_id: str(pick('campaign_id', 'campaignid')),
    campaign_name: str(pick('campaign_name', 'campaign')),
    ad_group_id: str(pick('adgroup_id', 'adset_id', 'ad_group_id')),
    ad_group_name: str(pick('adgroup_name', 'adgroup', 'adset_name', 'adset')),
    spend: num(pick('spend', 'cost', 'amount_spent')),
    impressions: Math.round(num(pick('impressions'))),
    clicks: Math.round(num(pick('clicks'))),
    conversions: pick('conversions', 'all_conversions', 'leads') !== undefined
      ? num(pick('conversions', 'all_conversions', 'leads'))
      : null,
    conversion_value: pick('conversion_value', 'all_conversion_value', 'revenue') !== undefined
      ? num(pick('conversion_value', 'all_conversion_value', 'revenue'))
      : null,
    metadata: { source: pick('datasource'), raw_keys: Object.keys(r).length },
  }
}
