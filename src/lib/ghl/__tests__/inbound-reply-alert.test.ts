import { describe, it, expect } from 'vitest'
import {
  shouldAlertInboundReply,
  INBOUND_REPLY_ALERT_MAX_AGE_MS,
} from '../inbound-reply-alert'
import type { NormalizedGhlMessage } from '../conversations'

const NOW = Date.parse('2026-07-21T20:00:00.000Z')

/** A fresh inbound Messenger DM, overridable per case. */
function msg(overrides: Partial<NormalizedGhlMessage> = {}): NormalizedGhlMessage {
  return {
    externalId: 'ghl_msg:abc',
    channel: 'messenger',
    direction: 'inbound',
    body: 'are you still taking new patients?',
    subject: null,
    createdAt: new Date(NOW - 60_000).toISOString(), // 1 min ago
    attachments: [],
    sourceType: 'TYPE_FACEBOOK',
    isCall: false,
    ...overrides,
  }
}

const base = { persistStatus: 'inserted' as const, leadCreatedNow: false, now: NOW }

describe('shouldAlertInboundReply', () => {
  it('alerts on a fresh inbound Messenger reply from an existing lead', () => {
    expect(shouldAlertInboundReply({ normalized: msg(), ...base })).toBe(true)
  })

  it('alerts on Instagram too', () => {
    expect(shouldAlertInboundReply({ normalized: msg({ channel: 'instagram' }), ...base })).toBe(true)
  })

  it('does NOT alert on our own outbound mirror', () => {
    expect(shouldAlertInboundReply({ normalized: msg({ direction: 'outbound' }), ...base })).toBe(false)
  })

  it('does NOT double-alert when this message just created the lead', () => {
    expect(shouldAlertInboundReply({ normalized: msg(), ...base, leadCreatedNow: true })).toBe(false)
  })

  it('does NOT alert on an idempotent re-delivery (skipped)', () => {
    expect(shouldAlertInboundReply({ normalized: msg(), ...base, persistStatus: 'skipped' })).toBe(false)
  })

  it('does NOT alert on non-social channels (SMS/email have no send window)', () => {
    expect(shouldAlertInboundReply({ normalized: msg({ channel: 'sms' }), ...base })).toBe(false)
    expect(shouldAlertInboundReply({ normalized: msg({ channel: 'email' }), ...base })).toBe(false)
  })

  it('does NOT alert on a null-channel routing marker', () => {
    expect(shouldAlertInboundReply({ normalized: msg({ channel: null }), ...base })).toBe(false)
  })

  it('does NOT alert on a stale message (poller/backfill history re-read)', () => {
    const stale = msg({ createdAt: new Date(NOW - INBOUND_REPLY_ALERT_MAX_AGE_MS - 1).toISOString() })
    expect(shouldAlertInboundReply({ normalized: stale, ...base })).toBe(false)
  })

  it('alerts right at the freshness boundary', () => {
    const edge = msg({ createdAt: new Date(NOW - INBOUND_REPLY_ALERT_MAX_AGE_MS).toISOString() })
    expect(shouldAlertInboundReply({ normalized: edge, ...base })).toBe(true)
  })

  it('does NOT alert when the timestamp is unparseable', () => {
    expect(shouldAlertInboundReply({ normalized: msg({ createdAt: 'not-a-date' }), ...base })).toBe(false)
  })
})
