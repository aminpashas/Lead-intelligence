import { describe, it, expect } from 'vitest'
import { buildRecommendations, labelChannel, type RecommendationInputs } from '@/lib/analytics/recommendations'
import type { ChannelScore, CampaignScore } from '@/lib/analytics/deep-types'

const channel = (over: Partial<ChannelScore>): ChannelScore => ({
  channel: 'ppc_meta',
  leads: 0,
  responded: 0,
  engaged: 0,
  consults: 0,
  converted: 0,
  disqualified: 0,
  untouched: 0,
  ready_to_book: 0,
  low_intent: 0,
  cost_objections: 0,
  financing_objections: 0,
  revenue: 0,
  spend: null,
  clicks: null,
  impressions: null,
  cpl: null,
  cost_per_engaged: null,
  cost_per_consult: null,
  ...over,
})

const campaign = (over: Partial<CampaignScore>): CampaignScore => ({
  campaign: 'Test Campaign',
  channel: 'ppc_meta',
  leads: 0,
  responded: 0,
  engaged: 0,
  consults: 0,
  converted: 0,
  disqualified: 0,
  ready_to_book: 0,
  cost_objections: 0,
  financing_objections: 0,
  revenue: 0,
  spend: null,
  cpl: null,
  cost_per_engaged: null,
  ...over,
})

const baseInputs = (): RecommendationInputs => ({
  channels: [],
  campaigns: [],
  unattributedSpend: [],
  speedToLead: {
    buckets: [],
    median_minutes: 3,
    pct_within_5min: 90,
    never_contacted: 0,
  },
  engagement: {
    touches_to_first_reply: [],
    channel_effectiveness: [],
    ai_vs_human: { ai_sent: 0, ai_replied: 0, human_sent: 0, human_replied: 0 },
  },
  actionQueue: {
    untouched_new: 0,
    ready_to_book_stale: 0,
    inbound_awaiting_reply: 0,
    engaged_gone_quiet: 0,
    samples: { ready_to_book_stale: [] },
  },
  tracking: {
    total: 0,
    with_channel: 0,
    with_utm_source: 0,
    with_utm_campaign: 0,
    paid_leads: 0,
    paid_with_campaign_name: 0,
    google_with_gclid: 0,
    meta_with_fbclid: 0,
    ai_scored: 0,
    conversation_analyzed: 0,
    direct_share: 0,
  },
})

describe('buildRecommendations', () => {
  it('returns no recommendations for a healthy account', () => {
    expect(buildRecommendations(baseInputs())).toEqual([])
  })

  it('flags budget imbalance when one paid channel is >3× worse per engaged lead', () => {
    const inputs = baseInputs()
    inputs.channels = [
      channel({ channel: 'ppc_meta', spend: 8000, engaged: 7, cost_per_engaged: 1143 }),
      channel({ channel: 'ppc_google', spend: 2000, engaged: 38, cost_per_engaged: 52 }),
    ]
    const recs = buildRecommendations(inputs)
    const rec = recs.find((r) => r.id === 'budget-imbalance')
    expect(rec).toBeDefined()
    expect(rec!.dgsRelevant).toBe(true)
    expect(rec!.title).toContain('Meta Ads')
    expect(rec!.evidence).toContain('$1,143')
  })

  it('does not flag budget imbalance below the 3× threshold or under $500 spend', () => {
    const inputs = baseInputs()
    inputs.channels = [
      channel({ channel: 'ppc_meta', spend: 8000, engaged: 80, cost_per_engaged: 100 }),
      channel({ channel: 'ppc_google', spend: 2000, engaged: 38, cost_per_engaged: 52 }),
    ]
    expect(buildRecommendations(inputs).find((r) => r.id === 'budget-imbalance')).toBeUndefined()

    inputs.channels = [
      channel({ channel: 'ppc_meta', spend: 400, engaged: 1, cost_per_engaged: 400 }),
      channel({ channel: 'ppc_google', spend: 450, engaged: 38, cost_per_engaged: 12 }),
    ]
    expect(buildRecommendations(inputs).find((r) => r.id === 'budget-imbalance')).toBeUndefined()
  })

  it('flags campaigns that spent ≥$300 with zero engaged leads', () => {
    const inputs = baseInputs()
    inputs.campaigns = [
      campaign({ campaign: 'Sleep Apnea Search', spend: 2633, leads: 40, responded: 2, engaged: 0, disqualified: 12 }),
      campaign({ campaign: 'Winner', spend: 900, leads: 30, engaged: 9 }),
      campaign({ campaign: 'Tiny', spend: 100, leads: 6, engaged: 0 }),
    ]
    const recs = buildRecommendations(inputs)
    expect(recs.filter((r) => r.id.startsWith('campaign-zero-engaged')).length).toBe(1)
    expect(recs.find((r) => r.id.includes('Sleep Apnea'))).toBeDefined()
  })

  it('escalates stale ready-to-book and unanswered inbound as critical, sorted first', () => {
    const inputs = baseInputs()
    inputs.actionQueue.ready_to_book_stale = 31
    inputs.actionQueue.inbound_awaiting_reply = 66
    inputs.tracking.total = 1000
    inputs.tracking.ai_scored = 0 // also fires medium ai-scoring-off
    const recs = buildRecommendations(inputs)
    expect(recs[0].severity).toBe('critical')
    expect(recs.map((r) => r.id)).toContain('ready-to-book-stale')
    expect(recs.map((r) => r.id)).toContain('inbound-awaiting-reply')
    // criticals sort before medium
    const firstMedium = recs.findIndex((r) => r.severity === 'medium')
    const lastCritical = recs.map((r) => r.severity).lastIndexOf('critical')
    expect(lastCritical).toBeLessThan(firstMedium)
  })

  it('flags speed-to-lead when under 30% first-touch within 5 minutes', () => {
    const inputs = baseInputs()
    inputs.speedToLead = {
      buckets: [
        { bucket: '4-24h', rank: 4, leads: 40, responded: 15, response_rate: 37.5, consult_rate: 2.5 },
        { bucket: 'never', rank: 6, leads: 26510, responded: 2092, response_rate: 7.9, consult_rate: 6.3 },
      ],
      median_minutes: 2040,
      pct_within_5min: 0,
      never_contacted: 26510,
    }
    const rec = buildRecommendations(inputs).find((r) => r.id === 'speed-to-lead')
    expect(rec).toBeDefined()
    expect(rec!.evidence).toContain('26,510')
    expect(rec!.evidence).toContain('1.4d')
  })

  it('flags tracking gaps: missing fbclid, low campaign-name coverage, unattributed spend', () => {
    const inputs = baseInputs()
    inputs.tracking = {
      ...inputs.tracking,
      total: 26616,
      paid_leads: 743,
      paid_with_campaign_name: 431,
      meta_with_fbclid: 0,
      direct_share: 25.1,
    }
    inputs.unattributedSpend = [
      { campaign_name: 'TMJ Google Search V2', channel: 'google_ads', spend: 565, clicks: 139, platform_conversions: 3 },
    ]
    const ids = buildRecommendations(inputs).map((r) => r.id)
    expect(ids).toContain('fbclid-missing')
    expect(ids).toContain('campaign-name-coverage')
    expect(ids).toContain('direct-share-high')
    expect(ids).toContain('unattributed-spend')
  })

  it('flags dead email channel only with meaningful volume', () => {
    const inputs = baseInputs()
    inputs.engagement.channel_effectiveness = [
      { channel: 'sms', outbound: 17858, leads_contacted: 13182, inbound: 1373, leads_responded: 586, lead_reply_rate: 4.4 },
      { channel: 'email', outbound: 368, leads_contacted: 144, inbound: 0, leads_responded: 0, lead_reply_rate: 0 },
    ]
    const rec = buildRecommendations(inputs).find((r) => r.id === 'email-dead')
    expect(rec).toBeDefined()

    inputs.engagement.channel_effectiveness[1].outbound = 50
    expect(buildRecommendations(inputs).find((r) => r.id === 'email-dead')).toBeUndefined()
  })

  it('marks only ads/creative/tracking recommendations as DGS-relevant', () => {
    const inputs = baseInputs()
    inputs.actionQueue.ready_to_book_stale = 5 // CRM-side
    inputs.tracking = { ...inputs.tracking, total: 1000, paid_leads: 100, meta_with_fbclid: 0, paid_with_campaign_name: 100 }
    const recs = buildRecommendations(inputs)
    expect(recs.find((r) => r.id === 'ready-to-book-stale')!.dgsRelevant).toBe(false)
    expect(recs.find((r) => r.id === 'fbclid-missing')!.dgsRelevant).toBe(true)
  })
})

describe('labelChannel', () => {
  it('maps known channels and untagged sources', () => {
    expect(labelChannel('ppc_meta')).toBe('Meta Ads')
    expect(labelChannel('untagged_ghl_import')).toBe('Untagged (ghl_import)')
    expect(labelChannel('mystery')).toBe('mystery')
  })
})
