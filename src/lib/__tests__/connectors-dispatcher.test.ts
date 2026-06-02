import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock all connector modules
vi.mock('@/lib/connectors/google-ads/offline-conversions', () => ({
  uploadClickConversion: vi.fn().mockResolvedValue({ connector: 'google_ads', success: true }),
}))
vi.mock('@/lib/connectors/google-ads/enhanced-conversions', () => ({
  uploadEnhancedConversionForLead: vi.fn().mockResolvedValue({ connector: 'google_ads', success: true }),
}))
vi.mock('@/lib/connectors/meta/capi', () => ({
  sendMetaConversionEvent: vi.fn().mockResolvedValue({ connector: 'meta_capi', success: true }),
}))
vi.mock('@/lib/connectors/ga4/measurement', () => ({
  sendGA4Event: vi.fn().mockResolvedValue({ connector: 'ga4', success: true }),
}))
vi.mock('@/lib/connectors/webhooks/outbound', () => ({
  sendOutboundWebhook: vi.fn().mockResolvedValue({ connector: 'outbound_webhook', success: true }),
}))
vi.mock('@/lib/connectors/slack/notify', () => ({
  sendSlackNotification: vi.fn().mockResolvedValue({ connector: 'slack', success: true }),
}))
vi.mock('@/lib/connectors/crypto', () => ({
  decryptCredentials: vi.fn((creds: unknown) => creds),
}))

import { dispatchConnectorEvent } from '@/lib/connectors/dispatcher'
import { uploadClickConversion } from '@/lib/connectors/google-ads/offline-conversions'
import { uploadEnhancedConversionForLead } from '@/lib/connectors/google-ads/enhanced-conversions'
import { sendMetaConversionEvent } from '@/lib/connectors/meta/capi'
import { sendGA4Event } from '@/lib/connectors/ga4/measurement'
import { sendOutboundWebhook } from '@/lib/connectors/webhooks/outbound'
import { sendSlackNotification } from '@/lib/connectors/slack/notify'
import type { ConnectorEvent, ConnectorConfig } from '@/lib/connectors/types'

// ── Helpers ─────────────────────────────────────────────────────

function makeEvent(overrides: Partial<ConnectorEvent> = {}): ConnectorEvent {
  return {
    type: 'lead.created',
    organizationId: 'org-1',
    leadId: 'lead-1',
    timestamp: '2026-01-15T10:00:00Z',
    data: {
      lead: {
        id: 'lead-1',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
        phone: '+14155551234',
        gclid: null,
        fbclid: null,
        ...overrides.data?.lead,
      },
      ...overrides.data,
    },
    ...overrides,
  }
}

function makeConfig(type: string, credentials: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `config-${type}`,
    organization_id: 'org-1',
    connector_type: type,
    enabled: true,
    credentials,
    settings: {},
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  }
}

function makeSupabase(configs: Array<Record<string, unknown>> = []) {
  const selectChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
  }
  // Make query chain thenable
  Object.defineProperty(selectChain, 'then', {
    value: (resolve: (v: unknown) => void) => resolve({ data: configs }),
    writable: true,
    configurable: true,
  })

  const insertChain = {
    insert: vi.fn().mockResolvedValue({ error: null }),
  }

  return {
    from: vi.fn((table: string) => {
      if (table === 'connector_events') return insertChain
      return selectChain
    }),
    _insertChain: insertChain,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Re-establish default mock return values cleared by vi.clearAllMocks()
  vi.mocked(uploadClickConversion).mockResolvedValue({ connector: 'google_ads', success: true })
  vi.mocked(uploadEnhancedConversionForLead).mockResolvedValue({ connector: 'google_ads', success: true })
  vi.mocked(sendMetaConversionEvent).mockResolvedValue({ connector: 'meta_capi', success: true })
  vi.mocked(sendGA4Event).mockResolvedValue({ connector: 'ga4', success: true })
  vi.mocked(sendOutboundWebhook).mockResolvedValue({ connector: 'outbound_webhook', success: true })
  vi.mocked(sendSlackNotification).mockResolvedValue({ connector: 'slack', success: true })
})

// ═══════════════════════════════════════════════════════════════
// Core Dispatcher
// ═══════════════════════════════════════════════════════════════

describe('dispatchConnectorEvent', () => {
  it('returns empty results when no connectors are configured', async () => {
    const supabase = makeSupabase([])
    const results = await dispatchConnectorEvent(supabase as any, makeEvent())
    expect(results).toEqual([])
  })

  it('returns empty results when configs query returns null', async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
    }
    Object.defineProperty(selectChain, 'then', {
      value: (resolve: (v: unknown) => void) => resolve({ data: null }),
      writable: true,
    })
    const supabase = {
      from: vi.fn().mockReturnValue(selectChain),
    }

    const results = await dispatchConnectorEvent(supabase as any, makeEvent())
    expect(results).toEqual([])
  })

  // ── Google Ads ──────────────────────────────────────────────

  it('routes Google Ads with gclid to uploadClickConversion', async () => {
    const configs = [makeConfig('google_ads', {
      customerId: '123',
      refreshToken: 'rt',
      conversionActions: [],
    })]
    const supabase = makeSupabase(configs)
    const event = makeEvent({ data: { lead: { id: 'l', firstName: 'J', lastName: 'D', gclid: 'abc123' } } })

    const results = await dispatchConnectorEvent(supabase as any, event)

    expect(uploadClickConversion).toHaveBeenCalledTimes(1)
    expect(uploadEnhancedConversionForLead).not.toHaveBeenCalled()
    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)
  })

  it('routes Google Ads without gclid to Enhanced Conversions', async () => {
    const configs = [makeConfig('google_ads', {
      customerId: '123',
      refreshToken: 'rt',
      conversionActions: [],
    })]
    const supabase = makeSupabase(configs)
    const event = makeEvent() // no gclid

    const results = await dispatchConnectorEvent(supabase as any, event)

    expect(uploadEnhancedConversionForLead).toHaveBeenCalledTimes(1)
    expect(uploadClickConversion).not.toHaveBeenCalled()
  })

  // ── Meta CAPI ─────────────────────────────────────────────

  it('dispatches to Meta CAPI connector', async () => {
    const configs = [makeConfig('meta_capi', {
      pixelId: 'px123',
      accessToken: 'token',
    })]
    const supabase = makeSupabase(configs)

    const results = await dispatchConnectorEvent(supabase as any, makeEvent())

    expect(sendMetaConversionEvent).toHaveBeenCalledTimes(1)
    expect(results).toHaveLength(1)
    expect(results[0].connector).toBe('meta_capi')
  })

  it('uses META_CAPI_TEST_EVENT_CODE env override', async () => {
    process.env.META_CAPI_TEST_EVENT_CODE = 'TEST99'
    const configs = [makeConfig('meta_capi', {
      pixelId: 'px123',
      accessToken: 'token',
    })]
    const supabase = makeSupabase(configs)

    await dispatchConnectorEvent(supabase as any, makeEvent())

    const callArgs = vi.mocked(sendMetaConversionEvent).mock.calls[0]
    expect(callArgs[1]).toHaveProperty('testEventCode', 'TEST99')

    delete process.env.META_CAPI_TEST_EVENT_CODE
  })

  // ── GA4 ───────────────────────────────────────────────────

  it('dispatches to GA4 connector', async () => {
    const configs = [makeConfig('ga4', {
      measurementId: 'G-123',
      apiSecret: 'secret',
    })]
    const supabase = makeSupabase(configs)

    const results = await dispatchConnectorEvent(supabase as any, makeEvent())

    expect(sendGA4Event).toHaveBeenCalledTimes(1)
    expect(results).toHaveLength(1)
  })

  // ── Outbound Webhook ──────────────────────────────────────

  it('dispatches to outbound webhook connector', async () => {
    const configs = [makeConfig('outbound_webhook', {
      url: 'https://hook.example.com',
      events: ['lead.created'],
    })]
    const supabase = makeSupabase(configs)

    const results = await dispatchConnectorEvent(supabase as any, makeEvent())

    expect(sendOutboundWebhook).toHaveBeenCalledTimes(1)
    expect(results).toHaveLength(1)
  })

  // ── Slack ─────────────────────────────────────────────────

  it('dispatches to Slack connector', async () => {
    const configs = [makeConfig('slack', {
      webhookUrl: 'https://hooks.slack.com/xxx',
      events: ['lead.created'],
    })]
    const supabase = makeSupabase(configs)

    const results = await dispatchConnectorEvent(supabase as any, makeEvent())

    expect(sendSlackNotification).toHaveBeenCalledTimes(1)
    expect(results).toHaveLength(1)
  })

  // ── Multiple connectors ───────────────────────────────────

  it('runs multiple connectors in parallel', async () => {
    const configs = [
      makeConfig('ga4', { measurementId: 'G-1', apiSecret: 's' }),
      makeConfig('slack', { webhookUrl: 'https://slack.com/x', events: ['lead.created'] }),
      makeConfig('meta_capi', { pixelId: 'px', accessToken: 't' }),
    ]
    const supabase = makeSupabase(configs)

    const results = await dispatchConnectorEvent(supabase as any, makeEvent())

    expect(results).toHaveLength(3)
    expect(sendGA4Event).toHaveBeenCalledTimes(1)
    expect(sendSlackNotification).toHaveBeenCalledTimes(1)
    expect(sendMetaConversionEvent).toHaveBeenCalledTimes(1)
  })

  // ── Error handling ────────────────────────────────────────

  it('catches connector errors without crashing', async () => {
    vi.mocked(sendGA4Event).mockRejectedValue(new Error('GA4 API down'))
    const configs = [makeConfig('ga4', { measurementId: 'G-1', apiSecret: 's' })]
    const supabase = makeSupabase(configs)

    const results = await dispatchConnectorEvent(supabase as any, makeEvent())

    // Error is caught and returned as a failed result
    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(false)
    expect(results[0].error).toContain('GA4 API down')
  })

  it('one failing connector does not block others', async () => {
    vi.mocked(sendGA4Event).mockRejectedValue(new Error('fail'))
    vi.mocked(sendSlackNotification).mockResolvedValue({ connector: 'slack', success: true })

    const configs = [
      makeConfig('ga4', { measurementId: 'G-1', apiSecret: 's' }),
      makeConfig('slack', { webhookUrl: 'https://slack.com/x', events: [] }),
    ]
    const supabase = makeSupabase(configs)

    const results = await dispatchConnectorEvent(supabase as any, makeEvent())

    expect(results).toHaveLength(2)
    // One success, one failure
    const successes = results.filter((r) => r.success)
    const failures = results.filter((r) => !r.success)
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
  })

  it('handles unknown connector type gracefully', async () => {
    const configs = [makeConfig('some_unknown_type', {})]
    const supabase = makeSupabase(configs)

    const results = await dispatchConnectorEvent(supabase as any, makeEvent())

    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(false)
    expect(results[0].error).toContain('Unknown connector type')
  })

  // ── Audit logging ─────────────────────────────────────────

  it('logs connector results to connector_events table', async () => {
    const configs = [makeConfig('ga4', { measurementId: 'G-1', apiSecret: 's' })]
    const supabase = makeSupabase(configs)

    await dispatchConnectorEvent(supabase as any, makeEvent())

    // Wait for the non-blocking log to execute
    await new Promise((r) => setTimeout(r, 50))

    expect(supabase._insertChain.insert).toHaveBeenCalled()
    const rows = supabase._insertChain.insert.mock.calls[0][0]
    expect(rows[0]).toMatchObject({
      organization_id: 'org-1',
      lead_id: 'lead-1',
      connector_type: 'ga4',
      success: true,
    })
  })
})
