/**
 * Per-org DgsFeedback builder — the payload Dion Growth Studio consumes.
 *
 * Mirrors the dgsFeedback construction in /api/analytics/deep (same RPCs, same
 * recommendations engine, same dgsRelevant filter) but runs only the subset of
 * deep-analytics RPCs the feedback payload needs, so the daily push cron can
 * call it with a service-role client for every org without paying for the full
 * dashboard aggregation.
 */

import { buildRecommendations } from '@/lib/analytics/recommendations'
import type { createServiceClient } from '@/lib/supabase/server'
import type {
  ActionQueue,
  CampaignScore,
  ChannelScore,
  DgsFeedback,
  EngagementFunnel,
  SpeedToLead,
  TrackingCoverage,
  UnattributedSpendRow,
} from '@/lib/analytics/deep-types'

type ServiceClient = ReturnType<typeof createServiceClient>

/**
 * Runs the scorecard RPCs for one org over [start, end] and assembles the
 * DgsFeedback payload. Throws on the first RPC error (a missing function means
 * migration 20260711100000 has not been applied) so the caller records a real
 * failure instead of pushing an empty payload.
 */
export async function buildDgsFeedbackForOrg(
  supabase: ServiceClient,
  orgId: string,
  range: { start: string; end: string }
): Promise<DgsFeedback> {
  const args = { p_org_id: orgId, p_start: range.start, p_end: range.end }

  const [channelsR, campaignsR, unattributedR, speedR, engagementR, queueR, coverageR] =
    await Promise.all([
      supabase.rpc('get_channel_scorecard', args),
      supabase.rpc('get_campaign_scorecard', args),
      supabase.rpc('get_unattributed_spend', args),
      supabase.rpc('get_speed_to_lead', args),
      supabase.rpc('get_engagement_funnel', args),
      supabase.rpc('get_action_queue', { p_org_id: orgId }),
      supabase.rpc('get_tracking_coverage', args),
    ])

  const firstError =
    channelsR.error || campaignsR.error || unattributedR.error || speedR.error ||
    engagementR.error || queueR.error || coverageR.error
  if (firstError) {
    throw new Error(`Deep analytics RPC failed: ${firstError.message}`)
  }

  const channels = (channelsR.data ?? []) as ChannelScore[]
  const campaigns = (campaignsR.data ?? []) as CampaignScore[]
  const unattributedSpend = (unattributedR.data ?? []) as UnattributedSpendRow[]
  const tracking = coverageR.data as TrackingCoverage

  const recommendations = buildRecommendations({
    channels,
    campaigns,
    unattributedSpend,
    speedToLead: speedR.data as SpeedToLead,
    engagement: engagementR.data as EngagementFunnel,
    actionQueue: queueR.data as ActionQueue,
    tracking,
  })

  return {
    generated_at: new Date().toISOString(),
    source: 'lead-intelligence',
    org_id: orgId,
    date_range: { start: range.start, end: range.end },
    channels,
    campaigns,
    unattributed_spend: unattributedSpend,
    tracking,
    recommendations: recommendations.filter((r) => r.dgsRelevant),
  }
}
