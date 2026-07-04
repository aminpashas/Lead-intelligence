import { describe, it, expect } from 'vitest'
import {
  mapGhlChannel,
  mapGhlDirection,
  isOptOutMessage,
  isOptInMessage,
  normalizeGhlMessage,
  type GhlMessage,
} from '@/lib/ghl/conversations'

describe('mapGhlChannel', () => {
  it('maps SMS/Email across webhook + API spellings', () => {
    expect(mapGhlChannel('TYPE_SMS')).toBe('sms')
    expect(mapGhlChannel('SMS')).toBe('sms')
    expect(mapGhlChannel('TYPE_EMAIL')).toBe('email')
    expect(mapGhlChannel('Email')).toBe('email')
  })

  it('routes calls and voicemails to the call marker', () => {
    expect(mapGhlChannel('TYPE_CALL')).toBe('call')
    expect(mapGhlChannel('TYPE_VOICEMAIL')).toBe('call')
  })

  it('maps whatsapp and web chat', () => {
    expect(mapGhlChannel('TYPE_WHATSAPP')).toBe('whatsapp')
    expect(mapGhlChannel('TYPE_LIVE_CHAT')).toBe('web_chat')
    expect(mapGhlChannel('TYPE_WEBCHAT')).toBe('web_chat')
  })

  it('returns null for unsupported channels', () => {
    expect(mapGhlChannel('TYPE_FACEBOOK')).toBeNull()
    expect(mapGhlChannel('TYPE_INSTAGRAM')).toBeNull()
    expect(mapGhlChannel(undefined)).toBeNull()
  })
})

describe('mapGhlDirection', () => {
  it('only outbound is outbound; everything else defaults inbound', () => {
    expect(mapGhlDirection('outbound')).toBe('outbound')
    expect(mapGhlDirection('OUTBOUND')).toBe('outbound')
    expect(mapGhlDirection('inbound')).toBe('inbound')
    expect(mapGhlDirection(undefined)).toBe('inbound')
  })
})

describe('opt-out / opt-in detection', () => {
  it('detects the TCPA opt-out keyword set (whole-message only)', () => {
    expect(isOptOutMessage('STOP')).toBe(true)
    expect(isOptOutMessage('  unsubscribe ')).toBe(true)
    expect(isOptOutMessage('Quit')).toBe(true)
    expect(isOptOutMessage('please stop texting me about the appointment')).toBe(false)
  })

  it('detects opt-back-in keywords', () => {
    expect(isOptInMessage('START')).toBe(true)
    expect(isOptInMessage('subscribe')).toBe(true)
    expect(isOptInMessage('yes please')).toBe(false)
  })
})

describe('normalizeGhlMessage', () => {
  const base: GhlMessage = {
    id: 'm1',
    messageType: 'TYPE_SMS',
    body: 'hi there',
    direction: 'inbound',
    dateAdded: '2026-01-02T03:04:05.000Z',
  }

  it('namespaces the external id and preserves the historical timestamp', () => {
    const n = normalizeGhlMessage(base)
    expect(n).not.toBeNull()
    expect(n!.externalId).toBe('ghl_msg:m1')
    expect(n!.channel).toBe('sms')
    expect(n!.direction).toBe('inbound')
    expect(n!.createdAt).toBe('2026-01-02T03:04:05.000Z')
    expect(n!.isCall).toBe(false)
  })

  it('keeps call records even with an empty body', () => {
    const n = normalizeGhlMessage({ id: 'c1', messageType: 'TYPE_CALL', body: '' })
    expect(n).not.toBeNull()
    expect(n!.isCall).toBe(true)
    expect(n!.channel).toBe('call')
  })

  it('skips empty-body non-call messages and unsupported channels', () => {
    expect(normalizeGhlMessage({ id: 'e1', messageType: 'TYPE_SMS', body: '   ' })).toBeNull()
    expect(normalizeGhlMessage({ id: 'f1', messageType: 'TYPE_FACEBOOK', body: 'hey' })).toBeNull()
    expect(normalizeGhlMessage({ id: '', messageType: 'TYPE_SMS', body: 'x' })).toBeNull()
  })
})
