// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { DeepAnalyticsPage } from '@/components/crm/deep-analytics'
import type { DeepAnalytics } from '@/lib/analytics/deep-types'

// The embedded classic Overview dashboard fetches its own endpoint and is
// covered elsewhere — stub it out.
vi.mock('@/components/crm/analytics-charts', () => ({
  AnalyticsDashboard: () => <div data-testid="classic-overview" />,
}))

const fixture: DeepAnalytics = {
  dateRange: { start: '2026-06-11T00:00:00Z', end: '2026-07-11T00:00:00Z' },
  qualityTiers: {
    total: 26616,
    tiers: [
      { tier: 'converted', rank: 0, count: 3, avg_outbound: 0, avg_inbound: 0, revenue: 8719, pipeline_value: 8719 },
      { tier: 'consult', rank: 1, count: 1670, avg_outbound: 0.2, avg_inbound: 0.1, revenue: 0, pipeline_value: 0 },
      { tier: 'engaged', rank: 2, count: 72, avg_outbound: 1.8, avg_inbound: 1.7, revenue: 0, pipeline_value: 0 },
      { tier: 'untouched', rank: 5, count: 7088, avg_outbound: 0, avg_inbound: 0, revenue: 0, pipeline_value: 0 },
    ],
  },
  channelScorecard: [
    {
      channel: 'ppc_meta', leads: 294, responded: 15, engaged: 7, consults: 3, converted: 0,
      disqualified: 130, untouched: 22, ready_to_book: 6, low_intent: 58, cost_objections: 2,
      financing_objections: 1, revenue: 0, spend: 8006, clicks: 2509, impressions: 73593,
      cpl: 27.23, cost_per_engaged: 1143.72, cost_per_consult: 2668.68,
    },
    {
      channel: 'ppc_google', leads: 449, responded: 38, engaged: 38, consults: 38, converted: 0,
      disqualified: 106, untouched: 295, ready_to_book: 0, low_intent: 1, cost_objections: 1,
      financing_objections: 0, revenue: 0, spend: 1954, clicks: 561, impressions: 11634,
      cpl: 4.35, cost_per_engaged: 51.43, cost_per_consult: 51.43,
    },
  ],
  campaignScorecard: [
    {
      campaign: 'Dion Health › Dental Implants [Video]**', channel: 'ppc_meta', leads: 155,
      responded: 8, engaged: 0, consults: 0, converted: 0, disqualified: 60, ready_to_book: 2,
      cost_objections: 1, financing_objections: 0, revenue: 0, spend: 7015, cpl: 45.26, cost_per_engaged: null,
    },
  ],
  unattributedSpend: [
    { campaign_name: 'TMJ Google Search V2', channel: 'google_ads', spend: 565.42, clicks: 139, platform_conversions: 3 },
  ],
  speedToLead: {
    buckets: [
      { bucket: '4-24h', rank: 4, leads: 40, responded: 15, response_rate: 37.5, consult_rate: 2.5 },
      { bucket: 'never', rank: 6, leads: 26510, responded: 2092, response_rate: 7.9, consult_rate: 6.3 },
    ],
    median_minutes: 2040.4,
    pct_within_5min: 0,
    never_contacted: 26510,
  },
  engagementFunnel: {
    touches_to_first_reply: [
      { touches: '1', rank: 1, leads: 8 },
      { touches: '5+', rank: 5, leads: 3 },
    ],
    channel_effectiveness: [
      { channel: 'sms', outbound: 17858, leads_contacted: 13182, inbound: 1373, leads_responded: 586, lead_reply_rate: 4.4 },
      { channel: 'email', outbound: 368, leads_contacted: 144, inbound: 0, leads_responded: 0, lead_reply_rate: 0 },
    ],
    ai_vs_human: { ai_sent: 10, ai_replied: 9, human_sent: 18216, human_replied: 1500 },
  },
  contactHeatmap: {
    lead_created: [{ dow: 1, hour: 10, count: 120 }],
    inbound_messages: [{ dow: 2, hour: 14, count: 33 }],
  },
  conversionLag: {
    to_consult_days_median: null,
    to_consult_count: 2128,
    to_converted_days_median: null,
    to_converted_count: 7,
  },
  actionQueue: {
    untouched_new: 11157,
    ready_to_book_stale: 31,
    inbound_awaiting_reply: 66,
    engaged_gone_quiet: 66,
    samples: {
      ready_to_book_stale: [{ id: 'abc-123', name: 'Jordan Dilley', last_contacted: null }],
    },
  },
  trackingCoverage: {
    total: 26616, with_channel: 12391, with_utm_source: 11369, with_utm_campaign: 960,
    paid_leads: 743, paid_with_campaign_name: 431, google_with_gclid: 386, meta_with_fbclid: 0,
    ai_scored: 0, conversation_analyzed: 5284, direct_share: 25.1,
  },
  intentObjections: {
    analyzed: 5284,
    intent: [
      { intent: 'disengaged', n: 4376 },
      { intent: 'ready_to_book', n: 282 },
    ],
    sentiment: [{ sentiment: 'negative', n: 2606 }],
    objections: [{ objection: 'cost', n: 402 }],
    red_flags: 12,
  },
  recommendations: [
    {
      id: 'budget-imbalance', severity: 'high', category: 'budget',
      title: 'Meta Ads pays 22× more per engaged lead than Google Ads',
      evidence: 'Meta Ads: $8,006 spend → 7 engaged.', action: 'Shift budget.', dgsRelevant: true,
    },
    {
      id: 'ready-to-book-stale', severity: 'critical', category: 'process',
      title: '31 ready-to-book leads have had no touch in 48h+',
      evidence: 'AI flagged ready_to_book.', action: 'Call them today.', dgsRelevant: false,
    },
  ],
  dgsFeedback: {
    generated_at: '2026-07-11T00:00:00Z',
    source: 'lead-intelligence',
    org_id: 'org-1',
    date_range: { start: '2026-06-11T00:00:00Z', end: '2026-07-11T00:00:00Z' },
    channels: [], campaigns: [], unattributed_spend: [],
    tracking: {
      total: 0, with_channel: 0, with_utm_source: 0, with_utm_campaign: 0, paid_leads: 0,
      paid_with_campaign_name: 0, google_with_gclid: 0, meta_with_fbclid: 0, ai_scored: 0,
      conversation_analyzed: 0, direct_share: 0,
    },
    recommendations: [],
  },
}

describe('DeepAnalyticsPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => fixture,
    })))
    // recharts ResponsiveContainer needs a sized element observer in jsdom
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders the Action Center with queues, recommendations, and DGS panel', async () => {
    render(<DeepAnalyticsPage />)

    await waitFor(() => {
      expect(screen.getByText('31 ready-to-book leads have had no touch in 48h+')).toBeTruthy()
    })
    // Work-queue tiles
    expect(screen.getByText('Ready-to-book, untouched 48h+')).toBeTruthy()
    expect(screen.getByText('11,157')).toBeTruthy()
    // Split lists
    expect(screen.getByText('Fix inside the CRM')).toBeTruthy()
    expect(screen.getByText('Feed back into Dion Growth Studio')).toBeTruthy()
    expect(screen.getByText('Meta Ads pays 22× more per engaged lead than Google Ads')).toBeTruthy()
    // Sample lead chip links to the lead
    expect(screen.getByText(/Jordan Dilley/)).toBeTruthy()
    // DGS export panel
    expect(screen.getByText(/Dion Growth Studio feedback payload/)).toBeTruthy()
  })

  it('renders the Campaigns tab scorecards with spend joins', async () => {
    render(<DeepAnalyticsPage />)
    await waitFor(() => expect(screen.getByText('Campaigns & Sources')).toBeTruthy())

    fireEvent.click(screen.getByText('Campaigns & Sources'))
    await waitFor(() => {
      expect(screen.getByText('Channel scorecard')).toBeTruthy()
    })
    // "Meta Ads" appears in both the channel scorecard and the campaign row's channel column
    expect(screen.getAllByText('Meta Ads').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Google Ads')).toBeTruthy()
    // Meta cost-per-engaged renders red-flagged value
    expect(screen.getByText('$1.1k')).toBeTruthy()
    // Unattributed spend card
    expect(screen.getByText('Spend with zero attributable leads')).toBeTruthy()
    expect(screen.getByText('TMJ Google Search V2')).toBeTruthy()
  })

  it('surfaces API errors with a retry affordance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Deep analytics RPC failed: boom' }),
    })))
    render(<DeepAnalyticsPage />)
    await waitFor(() => {
      expect(screen.getByText('Deep analytics RPC failed: boom')).toBeTruthy()
    })
    expect(screen.getByText('Retry')).toBeTruthy()
  })
})
