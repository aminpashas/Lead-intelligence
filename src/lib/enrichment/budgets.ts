/**
 * Per-provider monthly enrichment budgets.
 *
 * Caps how many enrichment rows each provider may create per organization per
 * calendar month, so a burst of leads can't blow through paid-API quotas
 * (Experian and ZeroBounce bill per lookup). The enrich cron consults these
 * caps and disables over-budget providers for the rest of the month.
 *
 * Defaults are env-overridable (integers, rows/month/org):
 *   ENRICH_BUDGET_EMAIL, ENRICH_BUDGET_PHONE, ENRICH_BUDGET_GEO,
 *   ENRICH_BUDGET_ADS, ENRICH_BUDGET_WEB, ENRICH_BUDGET_PREQUAL,
 *   ENRICH_BUDGET_EXPERIAN
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { ENRICHMENT_TYPES, type EnrichmentConfig, type EnrichmentType } from './types'

const BUDGET_ENV_VARS: Record<EnrichmentType, { env: string; default: number }> = {
  email_validation: { env: 'ENRICH_BUDGET_EMAIL', default: 5000 },
  phone_validation: { env: 'ENRICH_BUDGET_PHONE', default: 5000 },
  ip_geolocation: { env: 'ENRICH_BUDGET_GEO', default: 10000 },
  google_ads_keyword: { env: 'ENRICH_BUDGET_ADS', default: 10000 },
  website_behavior: { env: 'ENRICH_BUDGET_WEB', default: 50000 },
  credit_prequal: { env: 'ENRICH_BUDGET_PREQUAL', default: 2000 },
  experian_consumer: { env: 'ENRICH_BUDGET_EXPERIAN', default: 2000 },
}

/** Resolve budgets from env (falling back to defaults). Read at call time so tests can override. */
export function resolveMonthlyBudgets(
  env: Record<string, string | undefined> = process.env
): Record<EnrichmentType, number> {
  const out = {} as Record<EnrichmentType, number>
  for (const type of ENRICHMENT_TYPES) {
    const { env: envVar, default: def } = BUDGET_ENV_VARS[type]
    const raw = env[envVar]
    const parsed = raw !== undefined ? Number.parseInt(raw, 10) : NaN
    out[type] = Number.isFinite(parsed) && parsed >= 0 ? parsed : def
  }
  return out
}

/** First instant of the current calendar month (UTC), ISO string. */
export function monthStartIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

/** Pure: which providers are at/over their monthly budget. */
export function overBudgetTypes(
  counts: Partial<Record<EnrichmentType, number>>,
  budgets: Record<EnrichmentType, number>
): EnrichmentType[] {
  return ENRICHMENT_TYPES.filter((type) => (counts[type] ?? 0) >= budgets[type])
}

/** Turn a list of over-budget providers into an enrichLead config override. */
export function budgetConfigOverride(
  exceeded: EnrichmentType[]
): Partial<EnrichmentConfig> {
  const override: Partial<EnrichmentConfig> = {}
  for (const type of exceeded) override[type] = { enabled: false }
  return override
}

/**
 * Count lead_enrichment rows created this calendar month for one org,
 * per enrichment_type (cheap head-only count queries, one per provider).
 */
export async function getMonthlyEnrichmentCounts(
  supabase: SupabaseClient,
  organizationId: string,
  now: Date = new Date()
): Promise<Record<EnrichmentType, number>> {
  const since = monthStartIso(now)
  const counts = {} as Record<EnrichmentType, number>

  await Promise.all(
    ENRICHMENT_TYPES.map(async (type) => {
      const { count } = await supabase
        .from('lead_enrichment')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', organizationId)
        .eq('enrichment_type', type)
        .gte('created_at', since)
      counts[type] = count ?? 0
    })
  )

  return counts
}
