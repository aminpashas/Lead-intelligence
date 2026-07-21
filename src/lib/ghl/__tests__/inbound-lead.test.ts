import { describe, it, expect } from 'vitest'
import { isInboundCaptureMessage } from '@/lib/ghl/inbound-lead'
import type { NormalizedChannel, NormalizedGhlMessage } from '@/lib/ghl/conversations'

const msg = (over: Partial<NormalizedGhlMessage>): NormalizedGhlMessage => ({
  externalId: 'ghl:1',
  channel: 'sms',
  direction: 'inbound',
  body: 'is anyone there?',
  subject: null,
  createdAt: '2026-07-21T00:00:00Z',
  attachments: [],
  sourceType: 'TYPE_SMS',
  isCall: false,
  ...over,
})

describe('isInboundCaptureMessage', () => {
  it('accepts an inbound SMS — the exact bug: a new lead texting was dropped', () => {
    expect(isInboundCaptureMessage(msg({ channel: 'sms' }))).toBe(true)
  })

  it.each<NormalizedChannel>(['email', 'call', 'whatsapp', 'web_chat'])(
    'accepts inbound %s',
    (channel) => {
      expect(isInboundCaptureMessage(msg({ channel }))).toBe(true)
    },
  )

  it('rejects OUTBOUND — our own nurture blast to a non-lead must not mint a lead', () => {
    expect(isInboundCaptureMessage(msg({ direction: 'outbound' }))).toBe(false)
  })

  it.each<NormalizedChannel>(['messenger', 'instagram'])(
    'rejects social channel %s — those route to the social-DM creator (no phone/email)',
    (channel) => {
      expect(isInboundCaptureMessage(msg({ channel }))).toBe(false)
    },
  )

  it('rejects a null/unclassified channel — cannot attribute a source', () => {
    expect(isInboundCaptureMessage(msg({ channel: null }))).toBe(false)
  })
})
