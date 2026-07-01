/**
 * Campaign conversion attribution.
 *
 * `campaigns.total_converted` was declared in the schema and read by the stats
 * endpoint, analytics, and the dashboard — but NEVER written anywhere, so every
 * campaign showed 0 conversions regardless of real outcomes.
 *
 * Rather than hook every scattered status-change site (the leads PATCH route,
 * the contract-signing webhook, the treatment-closing flow, agent tools…) and
 * risk double-counting, this RECOMPUTES the counter from truth: a campaign's
 * conversions = the number of distinct leads it enrolled that are now in a
 * converted lifecycle status. Recompute-from-truth is idempotent and
 * self-healing — running it repeatedly converges to the correct value.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** Lifecycle statuses that count as a conversion (mirrors the analytics KPI). */
export const CONVERTED_LEAD_STATUSES = [
  'contract_signed',
  'scheduled',
  'in_treatment',
  'completed',
] as const

export function isConvertedLeadStatus(status: string | null | undefined): boolean {
  return !!status && (CONVERTED_LEAD_STATUSES as readonly string[]).includes(status)
}

/**
 * Count converted leads per campaign from enrollment rows. Each lead is counted
 * at most once per campaign (re-enrollment doesn't inflate the number). Pure —
 * unit-tested in isolation.
 */
export function countConvertedByCampaign(
  rows: Array<{ campaign_id: string | null; lead_id: string | null; lead_status: string | null }>
): Map<string, number> {
  const counts = new Map<string, number>()
  const seen = new Set<string>() // `${campaign_id}:${lead_id}` — one count per lead per campaign
  for (const r of rows) {
    if (!r.campaign_id || !r.lead_id) continue
    if (!isConvertedLeadStatus(r.lead_status)) continue
    const key = `${r.campaign_id}:${r.lead_id}`
    if (seen.has(key)) continue
    seen.add(key)
    counts.set(r.campaign_id, (counts.get(r.campaign_id) ?? 0) + 1)
  }
  return counts
}

/**
 * Recompute `total_converted` for every campaign in an org from current
 * enrollment + lead-status truth. Only writes campaigns whose stored count is
 * stale. Returns the number of campaigns updated.
 */
export async function reconcileCampaignConversions(
  supabase: SupabaseClient,
  organizationId: string
): Promise<number> {
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, total_converted')
    .eq('organization_id', organizationId)

  if (!campaigns || campaigns.length === 0) return 0
  const campaignIds = campaigns.map((c) => c.id as string)

  // Join enrollments to their lead's current status. Scope by campaign id
  // (org-scoped) so we don't assume an organization_id column on enrollments.
  const { data: enrollments } = await supabase
    .from('campaign_enrollments')
    .select('campaign_id, lead_id, lead:leads(status)')
    .in('campaign_id', campaignIds)

  const rows = (enrollments ?? []).map((e) => {
    const lead = (e as { lead?: { status?: string | null } | Array<{ status?: string | null }> }).lead
    const status = Array.isArray(lead) ? lead[0]?.status ?? null : lead?.status ?? null
    return {
      campaign_id: (e as { campaign_id: string | null }).campaign_id,
      lead_id: (e as { lead_id: string | null }).lead_id,
      lead_status: status,
    }
  })

  const counts = countConvertedByCampaign(rows)

  let updated = 0
  for (const c of campaigns) {
    const next = counts.get(c.id as string) ?? 0
    if ((c.total_converted ?? 0) !== next) {
      await supabase.from('campaigns').update({ total_converted: next }).eq('id', c.id as string)
      updated++
    }
  }
  return updated
}
