import { describe, it, expect } from 'vitest'
import {
  mapGhlChannel,
  mapGhlDirection,
  isOptOutMessage,
  isOptInMessage,
  normalizeGhlMessage,
  extractGhlCall,
  type GhlMessage,
} from '@/lib/ghl/conversations'
import { formatCallTitle } from '@/lib/ghl/ingest-message'
import { parseCallSummary } from '@/lib/voice/call-summary'

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

  it('maps social DM channels (previously dropped — no lead, no alert)', () => {
    expect(mapGhlChannel('TYPE_FACEBOOK')).toBe('messenger')
    expect(mapGhlChannel('TYPE_MESSENGER')).toBe('messenger')
    expect(mapGhlChannel('TYPE_INSTAGRAM')).toBe('instagram')
  })

  it('classifies IG before FB so a parent-prefixed IG type is not messenger', () => {
    expect(mapGhlChannel('TYPE_FB_INSTAGRAM')).toBe('instagram')
  })

  it('returns null for genuinely unsupported channels', () => {
    expect(mapGhlChannel('TYPE_GMB')).toBeNull()
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
    expect(normalizeGhlMessage({ id: 'f1', messageType: 'TYPE_GMB', body: 'hey' })).toBeNull()
    expect(normalizeGhlMessage({ id: '', messageType: 'TYPE_SMS', body: 'x' })).toBeNull()
  })

  // Regression: a real inbound Facebook DM arrived with body:'' and a single
  // .png on `attachments`, and the empty-body rule discarded it entirely — a
  // patient photographing their teeth produced no message and no alert.
  it('keeps an attachment-only message even when the body is empty', () => {
    const n = normalizeGhlMessage({
      id: 'a1',
      messageType: 'TYPE_FACEBOOK',
      body: '',
      direction: 'inbound',
      attachments: ['https://static-assets.example/conversations/x.png'],
    })
    expect(n).not.toBeNull()
    expect(n!.channel).toBe('messenger')
    expect(n!.body).toBe('')
    expect(n!.attachments).toEqual(['https://static-assets.example/conversations/x.png'])
  })

  it('still skips a message with neither body nor attachments', () => {
    expect(
      normalizeGhlMessage({ id: 'a2', messageType: 'TYPE_FACEBOOK', body: '', attachments: [] })
    ).toBeNull()
  })

  it('defaults attachments to [] and ignores non-string entries', () => {
    expect(normalizeGhlMessage(base)!.attachments).toEqual([])
    const n = normalizeGhlMessage({
      ...base,
      attachments: ['https://ok/1.png', '', '  '] as string[],
    })
    expect(n!.attachments).toEqual(['https://ok/1.png'])
  })

  it('preserves the raw GHL messageType so FB and IG stay distinguishable', () => {
    expect(normalizeGhlMessage({ ...base, messageType: 'TYPE_INSTAGRAM' })!.sourceType).toBe(
      'TYPE_INSTAGRAM'
    )
    expect(normalizeGhlMessage({ ...base, messageType: 'TYPE_FACEBOOK' })!.sourceType).toBe(
      'TYPE_FACEBOOK'
    )
  })

  it('normalizes an inbound Messenger DM into a persistable thread', () => {
    const n = normalizeGhlMessage({
      id: 'm1',
      messageType: 'TYPE_FACEBOOK',
      body: 'Do you do full arch implants?',
      direction: 'inbound',
    })
    expect(n).not.toBeNull()
    expect(n!.channel).toBe('messenger')
    expect(n!.isCall).toBe(false)
    expect(n!.direction).toBe('inbound')
  })
})

describe('extractGhlCall', () => {
  it('reads duration + state + recording from meta.call', () => {
    const c = extractGhlCall({
      id: 'c1',
      messageType: 'TYPE_CALL',
      meta: { call: { duration: 252, status: 'completed', recordingUrl: 'https://x/r.mp3' } },
    } as GhlMessage)
    expect(c.durationSec).toBe(252)
    expect(c.state).toBe('answered')
    expect(c.recordingUrl).toBe('https://x/r.mp3')
  })

  it('classifies voicemail / no-answer / busy defensively across key spellings', () => {
    expect(extractGhlCall({ id: 'a', meta: { callStatus: 'voicemail', callDuration: 8 } } as GhlMessage).state).toBe('voicemail')
    expect(extractGhlCall({ id: 'b', status: 'no-answer' } as GhlMessage).state).toBe('no_answer')
    expect(extractGhlCall({ id: 'c', meta: { call: { status: 'busy' } } } as GhlMessage).state).toBe('busy')
  })

  it('finds a recording in attachments and defaults unknown state / null duration', () => {
    const c = extractGhlCall({ id: 'd', attachments: ['https://cdn/rec.wav?sig=1'] } as unknown as GhlMessage)
    expect(c.recordingUrl).toBe('https://cdn/rec.wav?sig=1')
    expect(c.state).toBe('unknown')
    expect(c.durationSec).toBeNull()
  })

  it('is attached to normalized call records only', () => {
    const call = normalizeGhlMessage({ id: 'k', messageType: 'TYPE_CALL', meta: { call: { duration: 30, status: 'completed' } } } as GhlMessage)
    expect(call?.call?.durationSec).toBe(30)
    const sms = normalizeGhlMessage({ id: 's', messageType: 'TYPE_SMS', body: 'hi' })
    expect(sms?.call).toBeUndefined()
  })
})

describe('formatCallTitle', () => {
  it('renders outcome + duration when present', () => {
    const n = normalizeGhlMessage({ id: 'v', messageType: 'TYPE_CALL', direction: 'outbound', meta: { call: { duration: 8, status: 'voicemail' } } } as GhlMessage)!
    expect(formatCallTitle(n)).toBe('Outbound call · voicemail · 0:08 (GoHighLevel)')
  })

  it('degrades gracefully when GHL gave no call detail', () => {
    const n = normalizeGhlMessage({ id: 'w', messageType: 'TYPE_CALL', direction: 'inbound' } as GhlMessage)!
    expect(formatCallTitle(n)).toBe('Inbound call (GoHighLevel)')
  })
})

describe('parseCallSummary', () => {
  it('extracts a JSON object even with surrounding prose', () => {
    const s = parseCallSummary('Here you go:\n{"headline":"Wants pricing","topics":["cost"],"next_step":"Send quote","sentiment":"positive"}')
    expect(s?.headline).toBe('Wants pricing')
    expect(s?.topics).toEqual(['cost'])
    expect(s?.sentiment).toBe('positive')
    expect(s?.objections).toEqual([])
  })

  it('returns null on unparseable / headline-less output', () => {
    expect(parseCallSummary('no json here')).toBeNull()
    expect(parseCallSummary('{"topics":[]}')).toBeNull()
  })
})
