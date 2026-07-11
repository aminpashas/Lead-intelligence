import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { buildRecommendations } from '@/lib/analytics/recommendations'
import type {
  ActionQueue,
  CampaignScore,
  ChannelScore,
  ContactHeatmap,
  ConversionLag,
  DeepAnalytics,
  DgsFeedback,
  EngagementFunnel,
  IntentObjections,
  QualityTiers,
  SpeedToLead,
  TrackingCoverage,
  UnattributedSpendRow,
} from '@/lib/analytics/deep-types'

/**
 * GET /api/analytics/deep — behavior-first deep analytics.
 *
 * Aggregates the deep-analytics RPCs (quality tiers, channel/campaign
 * scorecards with spend, speed-to-lead, engagement funnel, heatmap, action
 * queue, tracking coverage) and runs the deterministic recommendations
 * engine. The dgsFeedback block is the campaign-quality payload Dion Growth
 * Studio consumes (join keys: campaign_attribution.channel, campaign_name).
 */
export async function GET(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()

  const { data: profile } = await getOwnProfile(supabase, 'organization_id')
  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Date range (default 30 days)
  const startParam = request.nextUrl.searchParams.get('start_date')
  const endParam = request.nextUrl.searchParams.get('end_date')
  const startDate = startParam
    ? new Date(startParam).toISOString()
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const endDate = endParam ? new Date(endParam).toISOString() : new Date().toISOString()

  const args = { p_org_id: orgId, p_start: startDate, p_end: endDate }

  const [
    tiersR,
    channelsR,
    campaignsR,
    unattributedR,
    speedR,
    engagementR,
    heatmapR,
    lagR,
    queueR,
    coverageR,
    intentR,
  ] = await Promise.all([
    supabase.rpc('get_quality_tiers', args),
    supabase.rpc('get_channel_scorecard', args),
    supabase.rpc('get_campaign_scorecard', args),
    supabase.rpc('get_unattributed_spend', args),
    supabase.rpc('get_speed_to_lead', args),
    supabase.rpc('get_engagement_funnel', args),
    supabase.rpc('get_contact_heatmap', args),
    supabase.rpc('get_conversion_lag', args),
    supabase.rpc('get_action_queue', { p_org_id: orgId }),
    supabase.rpc('get_tracking_coverage', args),
    supabase.rpc('get_intent_objections', args),
  ])

  const firstError =
    tiersR.error || channelsR.error || campaignsR.error || unattributedR.error ||
    speedR.error || engagementR.error || heatmapR.error || lagR.error ||
    queueR.error || coverageR.error || intentR.error
  if (firstError) {
    // The RPCs ship in migration 20260711100000 — a missing function means the
    // migration has not been applied to this environment yet. Surface that
    // clearly instead of rendering an empty dashboard.
    return NextResponse.json(
      { error: `Deep analytics RPC failed: ${firstError.message}` },
      { status: 500 }
    )
  }

  const qualityTiers = tiersR.data as QualityTiers
  const channelScorecard = (channelsR.data ?? []) as ChannelScore[]
  const campaignScorecard = (campaignsR.data ?? []) as CampaignScore[]
  const unattributedSpend = (unattributedR.data ?? []) as UnattributedSpendRow[]
  const speedToLead = speedR.data as SpeedToLead
  const engagementFunnel = engagementR.data as EngagementFunnel
  const contactHeatmap = heatmapR.data as ContactHeatmap
  const conversionLag = lagR.data as ConversionLag
  const actionQueue = queueR.data as ActionQueue
  const trackingCoverage = coverageR.data as TrackingCoverage
  const intentObjections = intentR.data as IntentObjections

  const recommendations = buildRecommendations({
    channels: channelScorecard,
    campaigns: campaignScorecard,
    unattributedSpend,
    speedToLead,
    engagement: engagementFunnel,
    actionQueue,
    tracking: trackingCoverage,
  })

  const dgsFeedback: DgsFeedback = {
    generated_at: new Date().toISOString(),
    source: 'lead-intelligence',
    org_id: orgId,
    date_range: { start: startDate, end: endDate },
    channels: channelScorecard,
    campaigns: campaignScorecard,
    unattributed_spend: unattributedSpend,
    tracking: trackingCoverage,
    recommendations: recommendations.filter((r) => r.dgsRelevant),
  }

  const payload: DeepAnalytics = {
    dateRange: { start: startDate, end: endDate },
    qualityTiers,
    channelScorecard,
    campaignScorecard,
    unattributedSpend,
    speedToLead,
    engagementFunnel,
    contactHeatmap,
    conversionLag,
    actionQueue,
    trackingCoverage,
    intentObjections,
    recommendations,
    dgsFeedback,
  }

  return NextResponse.json(payload)
}
