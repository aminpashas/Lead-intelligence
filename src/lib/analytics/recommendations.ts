/**
 * Deterministic recommendations engine for the deep-analytics dashboard.
 *
 * Pure function over the aggregated RPC payload — no I/O, fully unit-testable.
 * Every recommendation carries the numeric evidence that fired the rule plus a
 * concrete action, and is flagged dgsRelevant when the fix lives in Dion
 * Growth Studio (ads / creative / tracking) rather than inside the CRM.
 */

import type {
  ActionQueue,
  ChannelScore,
  CampaignScore,
  EngagementFunnel,
  Recommendation,
  SpeedToLead,
  TrackingCoverage,
  UnattributedSpendRow,
} from './deep-types'

const SEVERITY_ORDER: Record<Recommendation['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  info: 3,
}

const fmtMoney = (n: number) => `$${Math.round(n).toLocaleString()}`
const pct = (num: number, den: number) => (den > 0 ? (num / den) * 100 : 0)

export type RecommendationInputs = {
  channels: ChannelScore[]
  campaigns: CampaignScore[]
  unattributedSpend: UnattributedSpendRow[]
  speedToLead: SpeedToLead
  engagement: EngagementFunnel
  actionQueue: ActionQueue
  tracking: TrackingCoverage
}

export function buildRecommendations(inputs: RecommendationInputs): Recommendation[] {
  const recs: Recommendation[] = []
  const { channels, campaigns, unattributedSpend, speedToLead, engagement, actionQueue, tracking } = inputs

  // ── Budget: paid channel efficiency imbalance ────────────────────────────
  const paid = channels.filter((c) => (c.spend ?? 0) >= 500)
  const withCpe = paid.filter((c) => c.cost_per_engaged != null && c.engaged > 0)
  if (withCpe.length >= 2) {
    const sorted = [...withCpe].sort((a, b) => (a.cost_per_engaged! - b.cost_per_engaged!))
    const best = sorted[0]
    const worst = sorted[sorted.length - 1]
    if (worst.cost_per_engaged! > 3 * best.cost_per_engaged!) {
      recs.push({
        id: 'budget-imbalance',
        severity: 'high',
        category: 'budget',
        title: `${labelChannel(worst.channel)} pays ${Math.round(worst.cost_per_engaged! / best.cost_per_engaged!)}× more per engaged lead than ${labelChannel(best.channel)}`,
        evidence: `${labelChannel(worst.channel)}: ${fmtMoney(worst.spend!)} spend → ${worst.engaged} engaged (${fmtMoney(worst.cost_per_engaged!)}/engaged). ${labelChannel(best.channel)}: ${fmtMoney(best.spend!)} → ${best.engaged} engaged (${fmtMoney(best.cost_per_engaged!)}/engaged).`,
        action: `Shift incremental budget toward ${labelChannel(best.channel)} until its cost-per-engaged rises, and rework ${labelChannel(worst.channel)} targeting/creative before restoring spend.`,
        dgsRelevant: true,
      })
    }
  }

  // ── Budget/creative: campaigns burning spend with zero engaged leads ─────
  for (const c of campaigns) {
    if ((c.spend ?? 0) >= 300 && c.engaged === 0 && c.leads >= 5) {
      recs.push({
        id: `campaign-zero-engaged:${c.campaign}`,
        severity: 'high',
        category: 'creative',
        title: `"${truncate(c.campaign, 48)}" spent ${fmtMoney(c.spend!)} with zero engaged leads`,
        evidence: `${c.leads} leads, ${c.responded} responded, 0 reached the engaged tier; ${c.disqualified} disqualified.`,
        action: 'Pause or rebuild this campaign: new creative/audience, or route its leads into a faster follow-up cadence before spending more.',
        dgsRelevant: true,
        leadsHref: `/leads?campaign=${encodeURIComponent(c.campaign)}`,
      })
    }
  }

  // ── Creative: channel attracting low-intent traffic ──────────────────────
  for (const c of channels) {
    const analyzed = c.ready_to_book + c.low_intent
    if ((c.spend ?? 0) >= 500 && analyzed >= 20 && pct(c.low_intent, analyzed) >= 80) {
      recs.push({
        id: `low-intent:${c.channel}`,
        severity: 'medium',
        category: 'creative',
        title: `${labelChannel(c.channel)} leads skew heavily low-intent`,
        evidence: `Of ${analyzed} intent-analyzed leads, ${c.low_intent} are resistant/disengaged vs ${c.ready_to_book} ready-to-book (${pct(c.low_intent, analyzed).toFixed(0)}% low intent).`,
        action: 'Tighten the offer and qualifying friction (price anchoring, condition questions on the form) so the ad pre-filters curiosity clicks.',
        dgsRelevant: true,
      })
    }
  }

  // ── Creative/offer: cost & financing objections dominate ─────────────────
  const totalObjections = channels.reduce((s, c) => s + c.cost_objections + c.financing_objections, 0)
  const totalEngagedForObj = channels.reduce((s, c) => s + c.responded, 0)
  if (totalObjections >= 30 && totalEngagedForObj > 0) {
    recs.push({
      id: 'cost-objections',
      severity: 'medium',
      category: 'creative',
      title: 'Cost/financing is the dominant objection — lead with financing in ads and LPs',
      evidence: `${totalObjections} conversations hit a cost or financing objection across channels.`,
      action: 'Put monthly-payment framing ("from $X/mo") in ad copy and landing pages, and trigger the financing pre-qual flow earlier in the SMS cadence.',
      dgsRelevant: true,
    })
  }

  // ── Speed: first-touch latency ────────────────────────────────────────────
  if (speedToLead.pct_within_5min < 30) {
    const contacted = speedToLead.buckets.filter((b) => b.bucket !== 'never')
    const contactedLeads = contacted.reduce((s, b) => s + b.leads, 0)
    recs.push({
      id: 'speed-to-lead',
      severity: 'high',
      category: 'speed',
      title: `Only ${speedToLead.pct_within_5min.toFixed(0)}% of leads get a first touch within 5 minutes`,
      evidence: `Median tracked first-touch latency is ${formatMinutes(speedToLead.median_minutes)}; ${speedToLead.never_contacted.toLocaleString()} leads have no tracked outbound after capture${contactedLeads ? ` (${contactedLeads} tracked first-touches in range)` : ''}.`,
      action: 'Turn on an instant AI first-touch SMS for every new lead (webhook-triggered), with human follow-up inside business hours.',
      dgsRelevant: false,
    })
  }

  // ── Process: action-queue backlogs ────────────────────────────────────────
  if (actionQueue.ready_to_book_stale > 0) {
    recs.push({
      id: 'ready-to-book-stale',
      severity: 'critical',
      category: 'process',
      title: `${actionQueue.ready_to_book_stale} ready-to-book leads have had no touch in 48h+`,
      evidence: 'AI conversation analysis marked these leads ready_to_book, but they are not scheduled and have no recent outbound.',
      action: 'Call these leads today — they asked to book. Work the list in the Action Queue below.',
      dgsRelevant: false,
      cohortKey: 'ready_to_book_stale',
    })
  }
  if (actionQueue.inbound_awaiting_reply > 0) {
    recs.push({
      id: 'inbound-awaiting-reply',
      severity: 'critical',
      category: 'process',
      title: `${actionQueue.inbound_awaiting_reply} leads replied and are still waiting on you`,
      evidence: 'Their last inbound message is newer than your last outbound (past 14 days).',
      action: 'Clear the reply backlog — every unanswered inbound is a hand-raiser cooling off.',
      dgsRelevant: false,
      cohortKey: 'inbound_awaiting_reply',
    })
  }
  if (actionQueue.untouched_new >= 100) {
    const bestResponse = Math.max(...channels.map((c) => pct(c.responded, c.leads)), 0)
    recs.push({
      id: 'untouched-backlog',
      severity: 'high',
      category: 'process',
      title: `${actionQueue.untouched_new.toLocaleString()} new leads have never been contacted`,
      evidence: `They sit in status "new" with zero outbound.${bestResponse > 0 ? ` Your best channel response rate is ${bestResponse.toFixed(0)}%, so thousands of conversations are recoverable.` : ''}`,
      action: 'Run a segmented reactivation blitz (AI SMS first-touch, oldest last) instead of buying new traffic first.',
      dgsRelevant: false,
      cohortKey: 'untouched_new',
    })
  }
  if (actionQueue.engaged_gone_quiet >= 20) {
    recs.push({
      id: 'engaged-gone-quiet',
      severity: 'medium',
      category: 'process',
      title: `${actionQueue.engaged_gone_quiet} considering/exploring leads went quiet 7+ days ago`,
      evidence: 'These leads showed buying intent in conversation, then the thread died.',
      action: 'Enroll them in a re-engagement cadence (new information, not "just checking in") with a booking link.',
      dgsRelevant: false,
      cohortKey: 'engaged_gone_quiet',
    })
  }

  // ── Channel: dead email ───────────────────────────────────────────────────
  const email = engagement.channel_effectiveness.find((c) => c.channel === 'email')
  if (email && email.outbound >= 100 && email.leads_responded === 0) {
    recs.push({
      id: 'email-dead',
      severity: 'medium',
      category: 'process',
      title: `Email got ${email.outbound} sends and zero replies`,
      evidence: `${email.leads_contacted} leads emailed, 0 responded — SMS reply rate in the same window is ${engagement.channel_effectiveness.find((c) => c.channel === 'sms')?.lead_reply_rate ?? 0}%.`,
      action: 'Audit deliverability (SPF/DKIM/DMARC, sending domain warm-up) or drop email from cadences in favor of SMS.',
      dgsRelevant: false,
    })
  }

  // ── Tracking: attribution gaps that blind optimization ───────────────────
  if (tracking.paid_leads >= 50 && tracking.meta_with_fbclid === 0) {
    recs.push({
      id: 'fbclid-missing',
      severity: 'high',
      category: 'tracking',
      title: 'Meta leads carry no fbclid — CAPI match quality and ad optimization suffer',
      evidence: `${tracking.paid_leads} paid leads in range, 0 Meta leads have fbclid captured.`,
      action: 'Capture fbclid on landing pages and pass it through the webhook so Meta CAPI events match back to ads.',
      dgsRelevant: true,
    })
  }
  if (tracking.paid_leads >= 50 && pct(tracking.paid_with_campaign_name, tracking.paid_leads) < 70) {
    recs.push({
      id: 'campaign-name-coverage',
      severity: 'medium',
      category: 'tracking',
      title: `Only ${pct(tracking.paid_with_campaign_name, tracking.paid_leads).toFixed(0)}% of paid leads carry a campaign name`,
      evidence: `${tracking.paid_with_campaign_name} of ${tracking.paid_leads} paid leads have campaign attribution — the rest can't be tied to a specific campaign for optimization.`,
      action: 'Standardize UTM templates ({campaignname} value-track / Meta URL params) across all ad accounts in Dion Growth Studio.',
      dgsRelevant: true,
    })
  }
  if (tracking.direct_share >= 20) {
    recs.push({
      id: 'direct-share-high',
      severity: 'info',
      category: 'tracking',
      title: `${tracking.direct_share.toFixed(0)}% of attributed leads resolve to "direct"`,
      evidence: 'A large direct bucket usually hides paid/organic traffic with stripped parameters or untracked phone calls.',
      action: 'Extend call-tracking number coverage and audit landing pages that drop UTM parameters on redirect.',
      dgsRelevant: true,
    })
  }

  // ── Tracking: spend with no attributed leads ─────────────────────────────
  const wasted = unattributedSpend.filter((u) => u.spend >= 100)
  if (wasted.length > 0) {
    const total = wasted.reduce((s, u) => s + u.spend, 0)
    recs.push({
      id: 'unattributed-spend',
      severity: 'high',
      category: 'tracking',
      title: `${fmtMoney(total)} of ad spend produced zero attributable leads`,
      evidence: wasted
        .slice(0, 3)
        .map((u) => `"${truncate(u.campaign_name, 40)}" (${u.channel}) ${fmtMoney(u.spend)}, ${u.clicks} clicks, ${u.platform_conversions} platform conversions`)
        .join('; ') + '.',
      action: 'Either the campaign truly produced nothing (pause it) or its leads arrive untagged (fix LP tracking/webhook so the campaign name reaches the CRM).',
      dgsRelevant: true,
    })
  }

  // ── Data: AI scoring not running ─────────────────────────────────────────
  if (tracking.total >= 100 && pct(tracking.ai_scored, tracking.total) < 5) {
    recs.push({
      id: 'ai-scoring-off',
      severity: 'medium',
      category: 'data',
      title: 'AI lead scoring covers <5% of leads — score-based automation is blind',
      evidence: `${tracking.ai_scored} of ${tracking.total.toLocaleString()} leads in range have an AI score; conversation analysis covers ${tracking.conversation_analyzed.toLocaleString()}.`,
      action: 'Run the scoring sweep over the active pipeline (skip disqualified/imported-dead) so Hot/Warm tiers, forecasting, and routing come back to life.',
      dgsRelevant: false,
    })
  }

  return recs.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

export function labelChannel(channel: string): string {
  const map: Record<string, string> = {
    ppc_meta: 'Meta Ads',
    ppc_google: 'Google Ads',
    seo_organic: 'Organic Search',
    seo_gmb: 'Google Business Profile',
    seo_ai: 'AI Search',
    social_fb: 'Facebook (organic)',
    social_ig: 'Instagram',
    social_yelp: 'Yelp',
    referral: 'Referral',
    direct: 'Direct',
  }
  if (map[channel]) return map[channel]
  if (channel.startsWith('untagged_')) return `Untagged (${channel.slice('untagged_'.length)})`
  return channel
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function formatMinutes(min: number | null): string {
  if (min == null) return 'unknown'
  if (min < 60) return `${Math.round(min)}m`
  if (min < 1440) return `${(min / 60).toFixed(1)}h`
  return `${(min / 1440).toFixed(1)}d`
}
