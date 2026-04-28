/**
 * Brex client + sync runner.
 *
 * Brex provides a REST API for transactions:
 *   GET https://platform.brexapis.com/v2/transactions/cash?posted_at_start=<iso>&cursor=<cursor>
 *
 * Auth: Bearer token (long-lived "user token" or short-lived OAuth). For now we accept
 * the user token directly stored in connector_configs.credentials.api_key — that's
 * what Brex's "Personal Access Token" gives you.
 *
 * Per-org config in connector_configs (connector_type='brex'):
 *   credentials.api_key  — Brex API token
 *   settings.account_id  — optional: filter to a specific account
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { categorizeVendor, normalizeVendor } from './categorize'

const BREX_API_BASE = 'https://platform.brexapis.com'

export type BrexConfig = {
  api_key: string
  account_id?: string
}

export async function getBrexConfig(
  supabase: SupabaseClient,
  organizationId: string
): Promise<BrexConfig | null> {
  const { data } = await supabase
    .from('connector_configs')
    .select('credentials, settings, enabled')
    .eq('organization_id', organizationId)
    .eq('connector_type', 'brex')
    .single()

  if (!data || !data.enabled) return null

  const { decryptCredentials } = await import('@/lib/connectors/crypto')
  const creds = decryptCredentials(data.credentials as Record<string, unknown>) as Partial<BrexConfig>
  const settings = (data.settings || {}) as Partial<BrexConfig>

  if (!creds.api_key) return null
  return { api_key: creds.api_key, account_id: settings.account_id }
}

type BrexTransaction = {
  id: string
  description?: string
  amount?: { amount: number; currency: string }
  initiated_at_date?: string
  posted_at_date?: string
  card_metadata?: { card_last_four?: string; user_email?: string }
  merchant?: { raw_descriptor?: string; mcc?: string }
  category?: string
}

const PAGE_LIMIT = 100
const MAX_PAGES_PER_RUN = 10
const LOOKBACK_DAYS = 14   // re-pull last 2 weeks each run to catch posted-date adjustments

export type BrexRunResult = {
  fetched: number
  upserted: number
  by_category: Record<string, number>
  status: 'success' | 'partial' | 'failed'
  error?: string
  high_water?: string | null
}

export async function runBrexSync(
  supabase: SupabaseClient,
  organizationId: string,
  config: BrexConfig
): Promise<BrexRunResult> {
  const { data: state } = await supabase
    .from('brex_sync_state')
    .select('last_synced_posted_at')
    .eq('organization_id', organizationId)
    .maybeSingle()

  const lastSynced = state?.last_synced_posted_at as string | undefined
  const startDate = lastSynced
    ? new Date(new Date(lastSynced).getTime() - LOOKBACK_DAYS * 86400_000).toISOString()
    : new Date(Date.now() - 90 * 86400_000).toISOString()

  let cursor: string | undefined
  let fetched = 0
  let upserted = 0
  let highWater: string | null = lastSynced || null
  const byCategory: Record<string, number> = { acquisition: 0, platform: 0, other: 0 }

  try {
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const url = new URL(`${BREX_API_BASE}/v2/transactions/cash`)
      url.searchParams.set('posted_at_start', startDate)
      url.searchParams.set('limit', String(PAGE_LIMIT))
      if (cursor) url.searchParams.set('cursor', cursor)
      if (config.account_id) url.searchParams.set('account_id', config.account_id)

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${config.api_key}`, Accept: 'application/json' },
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Brex ${res.status}: ${text.slice(0, 300)}`)
      }
      const json = await res.json() as { items?: BrexTransaction[]; next_cursor?: string | null }
      const items = json.items || []

      for (const tx of items) {
        const postedAt = tx.posted_at_date || tx.initiated_at_date
        if (!postedAt) continue

        const amountCents = Math.round((tx.amount?.amount ?? 0))
        if (amountCents === 0) continue

        const vendorRaw = tx.merchant?.raw_descriptor || tx.description || null
        const vendorNormalized = normalizeVendor(vendorRaw)
        const cat = categorizeVendor(vendorRaw, tx.description ?? null)

        const row = {
          organization_id: organizationId,
          source: 'brex' as const,
          external_id: tx.id,
          posted_at: new Date(postedAt).toISOString(),
          amount_cents: amountCents,
          currency: (tx.amount?.currency || 'USD').toUpperCase(),
          vendor_name: vendorRaw,
          vendor_normalized: vendorNormalized,
          description: tx.description ?? null,
          card_last4: tx.card_metadata?.card_last_four ?? null,
          user_email: tx.card_metadata?.user_email ?? null,
          category: cat.category,
          subcategory: cat.subcategory,
          metadata: { mcc: tx.merchant?.mcc, brex_category: tx.category },
          raw_payload: tx as unknown as Record<string, unknown>,
        }

        // Upsert; preserve any staff-overridden category.
        const { data: existing } = await supabase
          .from('expense_line_items')
          .select('id, category_overridden')
          .eq('organization_id', organizationId)
          .eq('source', 'brex')
          .eq('external_id', tx.id)
          .maybeSingle()

        if (existing && existing.category_overridden) {
          // Refresh everything EXCEPT category/subcategory to respect the manual override.
          const { category: _c, subcategory: _s, ...keep } = row
          void _c
          void _s
          await supabase.from('expense_line_items').update(keep).eq('id', existing.id)
        } else {
          await supabase
            .from('expense_line_items')
            .upsert(row, { onConflict: 'organization_id,source,external_id' })
        }

        fetched++
        upserted++
        byCategory[cat.category] = (byCategory[cat.category] || 0) + amountCents

        if (!highWater || row.posted_at > highWater) highWater = row.posted_at
      }

      cursor = json.next_cursor ?? undefined
      if (!cursor) break
    }

    const status: 'success' | 'partial' = cursor ? 'partial' : 'success'
    await supabase
      .from('brex_sync_state')
      .upsert(
        {
          organization_id: organizationId,
          last_synced_posted_at: status === 'success' ? highWater : lastSynced,
          last_run_at: new Date().toISOString(),
          last_run_status: status,
          last_run_count: fetched,
        },
        { onConflict: 'organization_id' }
      )

    return { fetched, upserted, by_category: byCategory, status, high_water: highWater }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown'
    await supabase
      .from('brex_sync_state')
      .upsert(
        {
          organization_id: organizationId,
          last_run_at: new Date().toISOString(),
          last_run_status: 'failed',
          last_run_count: fetched,
          last_run_error: message,
        },
        { onConflict: 'organization_id' }
      )
    return { fetched, upserted, by_category: byCategory, status: 'failed', error: message }
  }
}
