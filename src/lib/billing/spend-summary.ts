/**
 * Spend rollup for the agency dashboard.
 *
 * `summarizeSpendRows` is the pure reducer over a normalized event list (AI usage + cost_events
 * flattened to a common shape). `loadAgencySpend` is the async loader the server components use —
 * it reads ai_usage + cost_events under the caller's RLS (agency admins see all practices) and
 * resolves practice names.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type SpendService = 'ai' | 'sms' | 'voice' | 'email'

export type SpendRow = {
  organizationId: string
  service: SpendService
  costCents: number
  billableCents: number
}

export type ServiceTotals = { costCents: number; billableCents: number }

export type SpendSummary = {
  totalCostCents: number
  totalBillableCents: number
  marginCents: number
  byService: Record<string, ServiceTotals>
  byOrg: Record<string, ServiceTotals>
}

export function summarizeSpendRows(rows: SpendRow[]): SpendSummary {
  const byService: Record<string, ServiceTotals> = {}
  const byOrg: Record<string, ServiceTotals> = {}
  let totalCostCents = 0
  let totalBillableCents = 0

  const bump = (bucket: Record<string, ServiceTotals>, key: string, cost: number, billable: number) => {
    const t = bucket[key] ?? { costCents: 0, billableCents: 0 }
    t.costCents += cost
    t.billableCents += billable
    bucket[key] = t
  }

  for (const r of rows) {
    totalCostCents += r.costCents
    totalBillableCents += r.billableCents
    bump(byService, r.service, r.costCents, r.billableCents)
    bump(byOrg, r.organizationId, r.costCents, r.billableCents)
  }

  return {
    totalCostCents,
    totalBillableCents,
    marginCents: totalBillableCents - totalCostCents,
    byService,
    byOrg,
  }
}

export type AgencySpend = {
  summary: SpendSummary
  orgNames: Record<string, string>
  sinceDays: number
}

/**
 * Load blended spend across every practice the caller can see (agency admins: all).
 * Reads under RLS with the passed client — the migration widened ai_usage/cost_events SELECT
 * to agency admins so this returns every practice's rows, not just the agency's own org.
 */
export async function loadAgencySpend(
  supabase: SupabaseClient,
  opts: { sinceDays?: number } = {},
): Promise<AgencySpend> {
  const sinceDays = opts.sinceDays ?? 30
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()

  const [aiRes, costRes] = await Promise.all([
    supabase
      .from('ai_usage')
      .select('organization_id, cost_cents, billable_cents')
      .gte('occurred_at', since),
    supabase
      .from('cost_events')
      .select('organization_id, service, cost_cents, billable_cents')
      .gte('event_at', since),
  ])

  const rows: SpendRow[] = []
  for (const r of aiRes.data ?? []) {
    rows.push({
      organizationId: r.organization_id as string,
      service: 'ai',
      costCents: Number(r.cost_cents ?? 0),
      billableCents: Number(r.billable_cents ?? 0),
    })
  }
  for (const r of costRes.data ?? []) {
    rows.push({
      organizationId: r.organization_id as string,
      service: (r.service as SpendService) ?? 'sms',
      costCents: Number(r.cost_cents ?? 0),
      billableCents: Number(r.billable_cents ?? 0),
    })
  }

  const summary = summarizeSpendRows(rows)

  const orgIds = Object.keys(summary.byOrg)
  const orgNames: Record<string, string> = {}
  if (orgIds.length > 0) {
    const { data: orgs } = await supabase.from('organizations').select('id, name').in('id', orgIds)
    for (const o of orgs ?? []) orgNames[o.id as string] = o.name as string
  }

  return { summary, orgNames, sinceDays }
}

/** Format integer-or-fractional cents as a USD string. Rounds only here, at display time. */
export function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

/** Margin as a percentage of billable (0 when nothing billed). */
export function marginPct(summary: SpendSummary): number {
  if (summary.totalBillableCents === 0) return 0
  return (summary.marginCents / summary.totalBillableCents) * 100
}
