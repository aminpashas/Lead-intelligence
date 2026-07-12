/**
 * Deep Analytics payload types — mirrors the JSON returned by the
 * deep-analytics RPCs (supabase/migrations/20260711100000_deep_analytics_rpcs.sql).
 *
 * "Quality tier" is the behavior-derived ladder computed by
 * analytics_lead_tier(): converted > consult > disqualified > engaged >
 * responded > contacted > untouched.
 */

export type QualityTier =
  | 'converted'
  | 'consult'
  | 'engaged'
  | 'responded'
  | 'contacted'
  | 'untouched'
  | 'disqualified'

export type TierRow = {
  tier: QualityTier
  rank: number
  count: number
  avg_outbound: number
  avg_inbound: number
  revenue: number
  pipeline_value: number
}

export type QualityTiers = { tiers: TierRow[]; total: number }

export type ChannelScore = {
  channel: string
  leads: number
  responded: number
  engaged: number
  consults: number
  converted: number
  disqualified: number
  untouched: number
  ready_to_book: number
  low_intent: number
  cost_objections: number
  financing_objections: number
  revenue: number
  spend: number | null
  clicks: number | null
  impressions: number | null
  cpl: number | null
  cost_per_engaged: number | null
  cost_per_consult: number | null
}

export type CampaignScore = {
  campaign: string
  channel: string
  leads: number
  responded: number
  engaged: number
  consults: number
  converted: number
  disqualified: number
  ready_to_book: number
  cost_objections: number
  financing_objections: number
  revenue: number
  spend: number | null
  cpl: number | null
  cost_per_engaged: number | null
}

export type UnattributedSpendRow = {
  campaign_name: string
  channel: string
  spend: number
  clicks: number
  platform_conversions: number
}

export type SpeedBucket = {
  bucket: string
  rank: number
  leads: number
  responded: number
  response_rate: number
  consult_rate: number
}

export type SpeedToLead = {
  buckets: SpeedBucket[]
  median_minutes: number | null
  pct_within_5min: number
  never_contacted: number
}

export type EngagementFunnel = {
  touches_to_first_reply: Array<{ touches: string; rank: number; leads: number }>
  channel_effectiveness: Array<{
    channel: string
    outbound: number
    leads_contacted: number
    inbound: number
    leads_responded: number
    lead_reply_rate: number
  }>
  ai_vs_human: {
    ai_sent: number
    ai_replied: number
    human_sent: number
    human_replied: number
  }
}

export type HeatmapCell = { dow: number; hour: number; count: number }
export type ContactHeatmap = { lead_created: HeatmapCell[]; inbound_messages: HeatmapCell[] }

export type ConversionLag = {
  to_consult_days_median: number | null
  to_consult_count: number
  to_converted_days_median: number | null
  to_converted_count: number
}

export type ActionQueue = {
  untouched_new: number
  ready_to_book_stale: number
  inbound_awaiting_reply: number
  engaged_gone_quiet: number
  samples: {
    ready_to_book_stale: Array<{ id: string; name: string; last_contacted: string | null }>
  }
}

/** Keys of the drillable action-queue cohorts — must match the CASE branches
 *  in analytics_in_action_cohort() (20260712100000_action_queue_cohort_rpc.sql). */
export type ActionQueueCohortKey =
  | 'untouched_new'
  | 'ready_to_book_stale'
  | 'inbound_awaiting_reply'
  | 'engaged_gone_quiet'

export const ACTION_QUEUE_COHORTS: Record<
  ActionQueueCohortKey,
  { label: string; description: string }
> = {
  ready_to_book_stale: {
    label: 'Ready-to-book, untouched 48h+',
    description: 'AI flagged them ready_to_book; no outbound touch in 48h+',
  },
  inbound_awaiting_reply: {
    label: 'Inbound awaiting your reply',
    description: 'Their last inbound (past 14d) is newer than your last outbound',
  },
  untouched_new: {
    label: 'New leads never contacted',
    description: 'Status "new", zero outbound ever, captured over a day ago',
  },
  engaged_gone_quiet: {
    label: 'Engaged leads gone quiet 7d+',
    description: 'Showed considering/exploring intent, then the thread died',
  },
}

export function isActionQueueCohortKey(v: string): v is ActionQueueCohortKey {
  return v in ACTION_QUEUE_COHORTS
}

/** One row of a cohort drill-down list (get_action_queue_cohort RPC). */
export type ActionQueueCohortLead = {
  id: string
  name: string
  status: string
  conversation_intent: string | null
  last_contacted_at: string | null
  last_responded_at: string | null
  created_at: string
}

export type ActionQueueCohortPage = {
  cohort: ActionQueueCohortKey
  total: number
  leads: ActionQueueCohortLead[]
}

export type TrackingCoverage = {
  total: number
  with_channel: number
  with_utm_source: number
  with_utm_campaign: number
  paid_leads: number
  paid_with_campaign_name: number
  google_with_gclid: number
  meta_with_fbclid: number
  ai_scored: number
  conversation_analyzed: number
  direct_share: number
}

export type IntentObjections = {
  analyzed: number
  intent: Array<{ intent: string; n: number }>
  sentiment: Array<{ sentiment: string; n: number }>
  objections: Array<{ objection: string; n: number }>
  red_flags: number
}

export type RecommendationSeverity = 'critical' | 'high' | 'medium' | 'info'
export type RecommendationCategory =
  | 'budget'
  | 'creative'
  | 'speed'
  | 'process'
  | 'tracking'
  | 'data'

export type Recommendation = {
  id: string
  severity: RecommendationSeverity
  category: RecommendationCategory
  title: string
  /** The concrete numbers that triggered this recommendation. */
  evidence: string
  /** What to do about it, phrased as an executable action. */
  action: string
  /** True when the action lives in Dion Growth Studio (ads/creative/tracking) rather than the CRM. */
  dgsRelevant: boolean
  /** When set, this recommendation is backed by a drillable lead cohort — the
   *  UI opens the cohort sheet (lead list + batch actions) for it. */
  cohortKey?: ActionQueueCohortKey
  /** When set, deep-link to the /leads table pre-filtered (e.g. by campaign). */
  leadsHref?: string
}

export type DgsFeedback = {
  generated_at: string
  source: 'lead-intelligence'
  org_id: string
  date_range: { start: string; end: string }
  /** Per-channel lead quality — join key: campaign_attribution.channel. */
  channels: ChannelScore[]
  /** Per-campaign lead quality — join key: campaign_name / utm_campaign. */
  campaigns: CampaignScore[]
  unattributed_spend: UnattributedSpendRow[]
  tracking: TrackingCoverage
  recommendations: Recommendation[]
}

export type DeepAnalytics = {
  dateRange: { start: string; end: string }
  qualityTiers: QualityTiers
  channelScorecard: ChannelScore[]
  campaignScorecard: CampaignScore[]
  unattributedSpend: UnattributedSpendRow[]
  speedToLead: SpeedToLead
  engagementFunnel: EngagementFunnel
  contactHeatmap: ContactHeatmap
  conversionLag: ConversionLag
  actionQueue: ActionQueue
  trackingCoverage: TrackingCoverage
  intentObjections: IntentObjections
  recommendations: Recommendation[]
  dgsFeedback: DgsFeedback
}
