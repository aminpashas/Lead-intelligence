/**
 * Reactivation funnel attribution.
 *
 * `reactivation_campaigns.total_responded / total_reactivated / total_converted`
 * were read by the reactivation dashboard/analytics but NEVER written, so the
 * proof-of-value funnel (the whole point of a reactivation campaign — did we
 * wake dormant patients back up?) showed permanent zeros.
 *
 * A reactivation campaign wraps an underlying drip `campaign_id`, so we
 * recompute its funnel from the same enrollment → lead-status truth used for
 * campaign conversions. Recompute-from-truth is idempotent and self-healing.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { isConvertedLeadStatus } from './reconcile-conversions'

/**
 * Statuses that indicate a dormant lead genuinely re-engaged (moved past a
 * qualifying conversation into the active pipeline). Superset of the converted
 * statuses.
 */
export const REACTIVATED_LEAD_STATUSES = [
  'consultation_scheduled',
  'consultation_completed',
  'treatment_presented',
  'financing',
  'contract_sent',
  'contract_signed',
  'scheduled',
  'in_treatment',
  'completed',
] as const

export function isReactivatedLeadStatus(status: string | null | undefined): boolean {
  return !!status && (REACTIVATED_LEAD_STATUSES as readonly string[]).includes(status)
}

export interface ReactivationFunnel {
  responded: number
  reactivated: number
  converted: number
}

/**
 * Compute the reactivation funnel from a DEDUPED list of enrolled leads.
 *   - responded: the lead has replied at least once (any inbound message)
 *   - reactivated: the lead re-entered the active pipeline
 *   - converted: the lead reached a closed-won status
 * Pure — unit-tested in isolation. Callers must dedupe by lead first.
 */
export function computeReactivationFunnel(
  leads: Array<{ status: string | null; total_messages_received: number | null }>
): ReactivationFunnel {
  let responded = 0
  let reactivated = 0
  let converted = 0
  for (const l of leads) {
    if ((l.total_messages_received ?? 0) > 0) responded++
    if (isReactivatedLeadStatus(l.status)) reactivated++
    if (isConvertedLeadStatus(l.status)) converted++
  }
  return { responded, reactivated, converted }
}

/**
 * Recompute the funnel counters for every reactivation campaign in an org from
 * current enrollment + lead truth. Only writes rows whose stored counters are
 * stale. Returns the number of reactivation campaigns updated.
 */
export async function reconcileReactivationFunnels(
  supabase: SupabaseClient,
  organizationId: string
): Promise<number> {
  const { data: reactivations } = await supabase
    .from('reactivation_campaigns')
    .select('id, campaign_id, total_responded, total_reactivated, total_converted')
    .eq('organization_id', organizationId)

  if (!reactivations || reactivations.length === 0) return 0

  let updated = 0
  for (const rc of reactivations) {
    const campaignId = (rc as { campaign_id: string | null }).campaign_id
    if (!campaignId) continue

    const { data: enrollments } = await supabase
      .from('campaign_enrollments')
      .select('lead_id, lead:leads(status, total_messages_received)')
      .eq('campaign_id', campaignId)

    // Dedupe by lead — a lead enrolled once per reactivation campaign.
    const seen = new Set<string>()
    const leads: Array<{ status: string | null; total_messages_received: number | null }> = []
    for (const e of enrollments ?? []) {
      const leadId = (e as { lead_id: string | null }).lead_id
      if (!leadId || seen.has(leadId)) continue
      seen.add(leadId)
      const leadRel = (e as { lead?: { status?: string | null; total_messages_received?: number | null } | Array<{ status?: string | null; total_messages_received?: number | null }> }).lead
      const lead = Array.isArray(leadRel) ? leadRel[0] : leadRel
      leads.push({
        status: lead?.status ?? null,
        total_messages_received: lead?.total_messages_received ?? 0,
      })
    }

    const funnel = computeReactivationFunnel(leads)
    const row = rc as { total_responded: number | null; total_reactivated: number | null; total_converted: number | null; id: string }
    if (
      (row.total_responded ?? 0) !== funnel.responded ||
      (row.total_reactivated ?? 0) !== funnel.reactivated ||
      (row.total_converted ?? 0) !== funnel.converted
    ) {
      await supabase
        .from('reactivation_campaigns')
        .update({
          total_responded: funnel.responded,
          total_reactivated: funnel.reactivated,
          total_converted: funnel.converted,
        })
        .eq('id', row.id)
      updated++
    }
  }
  return updated
}
