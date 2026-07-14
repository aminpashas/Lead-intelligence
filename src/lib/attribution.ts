/**
 * Display helpers for campaign-level attribution synced from Dion Growth
 * Studio (leads.campaign_attribution). Channel codes follow DGS's
 * metrics_daily convention (ppc_google, seo_gmb, offline_ctv, ...).
 */
import type { CampaignAttribution } from '@/types/database'

const CHANNEL_LABELS: Record<string, string> = {
  ppc_google: 'Google Ads',
  ppc_meta: 'Meta Ads',
  ppc_microsoft: 'Microsoft Ads',
  ppc_linkedin: 'LinkedIn Ads',
  ppc_tiktok: 'TikTok Ads',
  ppc_reddit: 'Reddit Ads',
  ppc_pinterest: 'Pinterest Ads',
  ppc_youtube: 'YouTube Ads',
  ppc_nextdoor: 'Nextdoor Ads',
  seo_organic: 'Organic Search',
  seo_gmb: 'Google Business Profile',
  seo_ai: 'AI Assistant',
  social_fb: 'Facebook',
  social_ig: 'Instagram',
  social_yelp: 'Yelp',
  social_nextdoor: 'Nextdoor',
  social_reddit: 'Reddit',
  social_youtube: 'YouTube',
  offline_ctv: 'Streaming TV',
  offline_radio: 'Radio',
  offline_directmail: 'Direct Mail',
  referral: 'Referral',
  direct: 'Direct',
}

export function channelLabel(channel: string | null | undefined): string | null {
  if (!channel) return null
  return CHANNEL_LABELS[channel] ?? channel.replace(/_/g, ' ')
}

/**
 * Lead-capture aggregators and call-tracking tools that are NOT a real traffic
 * source — they're the plumbing that captured the lead, not where the lead came
 * from. A lead whose raw `source` label is one of these actually originated from
 * whatever channel the underlying visit/call came through (Organic Search,
 * Direct, Google Ads, …), which lives in its resolved attribution channel.
 */
const AGGREGATOR_SOURCE_LABELS = new Set([
  'whatconverts',
  'gohighlevel',
  'ghl',
  'dgs',
  'dion growth studio',
])

/**
 * The source label to SHOW for a lead. Genuine source labels are kept verbatim.
 * An aggregator/call-tracking label ("whatconverts", "gohighlevel", …) is
 * replaced by the resolved attribution channel ("Organic Search", "Direct", …)
 * so staff see where the lead actually came from, never the tracking tool. When
 * the label is an aggregator and no channel is known, falls back to the raw
 * label rather than showing nothing. Returns null when nothing is known.
 */
export function displaySourceLabel(
  rawSource: string | null | undefined,
  channel: string | null | undefined,
): string | null {
  const raw = (rawSource ?? '').trim()
  if (raw && !AGGREGATOR_SOURCE_LABELS.has(raw.toLowerCase())) return raw
  return channelLabel(channel) ?? (raw || null)
}

/**
 * DGS-resolved channel codes that represent genuine *paid* Meta / Google ad
 * campaigns. This is the definition of a "new lead" for dashboard acquisition
 * metrics — everything else (direct, organic, GMB, referral, and imported
 * nurturing-database rows such as the GoHighLevel bulk) is intentionally
 * excluded so those figures reflect only fresh ad-driven demand.
 */
export const PAID_AD_CHANNELS = ['ppc_google', 'ppc_meta'] as const

/**
 * PostgREST `.or()` filter string selecting leads whose DGS-resolved channel
 * (leads.campaign_attribution->>channel) is a paid Google/Meta ad. Use as
 * `query.or(PAID_AD_CHANNEL_OR_FILTER)`. Mirrors the JSON-path filter style
 * already used on the /leads page.
 */
export const PAID_AD_CHANNEL_OR_FILTER = PAID_AD_CHANNELS.map(
  (c) => `campaign_attribution->>channel.eq.${c}`,
).join(',')

/**
 * One-line campaign summary for list views: "Google Ads — Implants June".
 * Falls back to channel-only or campaign-only when the other half is missing;
 * null when there is nothing meaningful to show (unresolved or direct with no
 * campaign — the bare source_type label already covers that case).
 */
export function formatCampaignAttribution(
  attr: CampaignAttribution | null | undefined,
): string | null {
  if (!attr) return null
  const channel = channelLabel(attr.channel)
  const campaign = attr.campaign_name || null
  if (channel && campaign) return `${channel} — ${campaign}`
  if (campaign) return campaign
  // A resolved channel with no campaign is still better than "Gohighlevel",
  // except 'direct' which carries no information.
  if (channel && attr.channel !== 'direct') return channel
  return null
}
