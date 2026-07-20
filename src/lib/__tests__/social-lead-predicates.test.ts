import { describe, it, expect } from 'vitest'
import { isSocialMessage, isNewSocialLead } from '@/lib/ghl/social-lead'
import type { NormalizedGhlMessage } from '@/lib/ghl/conversations'

function msg(over: Partial<NormalizedGhlMessage>): NormalizedGhlMessage {
  return {
    externalId: 'ghl_msg:x',
    channel: 'messenger',
    direction: 'inbound',
    body: 'hi',
    subject: null,
    createdAt: '2026-07-19T00:00:00.000Z',
    isCall: false,
    call: null,
    ...over,
  } as NormalizedGhlMessage
}

describe('isSocialMessage — either direction', () => {
  it('accepts inbound and outbound messenger', () => {
    expect(isSocialMessage(msg({ direction: 'inbound' }))).toBe(true)
    expect(isSocialMessage(msg({ direction: 'outbound' }))).toBe(true)
  })

  it('accepts instagram', () => {
    expect(isSocialMessage(msg({ channel: 'instagram' }))).toBe(true)
  })

  it('rejects non-social channels', () => {
    for (const ch of ['sms', 'email', 'web_chat', 'whatsapp', 'call'] as const) {
      expect(isSocialMessage(msg({ channel: ch }))).toBe(false)
    }
  })
})

describe('isNewSocialLead — inbound only (webhook stays strict)', () => {
  it('accepts an inbound DM', () => {
    expect(isNewSocialLead(msg({ direction: 'inbound' }))).toBe(true)
  })

  it('rejects our own outbound reply — it must not mint a lead mid-thread', () => {
    expect(isNewSocialLead(msg({ direction: 'outbound' }))).toBe(false)
  })

  it('rejects inbound SMS — create-on-miss is social-only by design', () => {
    // Widening this to sms/email would mint leads from the 240k-message
    // unmatched backlog. Guard it with a test so nobody relaxes it casually.
    expect(isNewSocialLead(msg({ channel: 'sms', direction: 'inbound' }))).toBe(false)
    expect(isNewSocialLead(msg({ channel: 'email', direction: 'inbound' }))).toBe(false)
  })
})
