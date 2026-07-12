import type { SupabaseClient } from '@supabase/supabase-js'
import { effectiveTierId, limitsForSubscriptionTier, TIERS, type PlanLimits, type TierId } from '@/lib/billing/tiers'

/** An org's resolved plan for quota checks: raw tier, effective ladder rung, limits. */
export type OrgPlan = {
  subscriptionTier: string
  tierId: TierId
  limits: PlanLimits
}

export async function getOrgPlan(supabase: SupabaseClient, orgId: string): Promise<OrgPlan> {
  const { data } = await supabase
    .from('organizations')
    .select('subscription_tier')
    .eq('id', orgId)
    .single()
  const subscriptionTier = (data?.subscription_tier as string | null) ?? 'trial'
  return {
    subscriptionTier,
    tierId: effectiveTierId(subscriptionTier),
    limits: limitsForSubscriptionTier(subscriptionTier),
  }
}

export type CapacityCheck =
  | { allowed: true; used: number; limit: number | null }
  | { allowed: false; used: number; limit: number; message: string }

/** Statuses that occupy a campaign slot — completed/archived campaigns release theirs. */
const LIVE_CAMPAIGN_STATUSES = ['draft', 'active', 'paused'] as const

/**
 * May this org create one more campaign? Counts live campaigns against the
 * plan quota. Callers gate every campaigns INSERT on this (manual create,
 * onboarding launch, reactivation) so the Basic 1-campaign cap can't be
 * side-stepped through an alternate creation path.
 */
export async function checkCampaignCapacity(
  supabase: SupabaseClient,
  orgId: string
): Promise<CapacityCheck> {
  const plan = await getOrgPlan(supabase, orgId)
  const limit = plan.limits.maxCampaigns
  const { count } = await supabase
    .from('campaigns')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .in('status', [...LIVE_CAMPAIGN_STATUSES])
  const used = count ?? 0
  if (limit === null || used < limit) return { allowed: true, used, limit }
  return {
    allowed: false,
    used,
    limit,
    message: campaignLimitMessage(plan.tierId, limit),
  }
}

function campaignLimitMessage(tierId: TierId, limit: number): string {
  const name = TIERS[tierId].name
  const next = tierId === 'basic' ? 'Growth' : 'Full'
  return `Your ${name} plan includes ${limit} live campaign${limit === 1 ? '' : 's'}. Complete or archive one, or upgrade to ${next} for more.`
}

export function brandLimitMessage(tierId: TierId, limit: number): string {
  const name = TIERS[tierId].name
  const next = tierId === 'basic' ? 'Growth' : 'Full'
  return `Your ${name} plan includes ${limit} brand${limit === 1 ? '' : 's'}. Upgrade to ${next} to add more brands.`
}
