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

describe('extractGhlCall', () => {
  it('reads duration + state from the confirmed meta.call shape', () => {
    // The real payload: {"call":{"duration":13,"status":"completed"}} (probe).
    const c = extractGhlCall({
      id: 'c1',
      messageType: 'TYPE_CALL',
      meta: { call: { duration: 252, status: 'completed' } },
    } as GhlMessage)
    expect(c.durationSec).toBe(252)
    expect(c.state).toBe('answered')
    expect(c.recordingUrl).toBeNull()
    expect(c.raw).toEqual({ call: { duration: 252, status: 'completed' } })
  })

  it('maps the probe-observed statuses (completed / ringing / failed)', () => {
    expect(extractGhlCall({ id: 'a', meta: { call: { duration: 13, status: 'completed' } } } as GhlMessage).state).toBe('answered')
    expect(extractGhlCall({ id: 'b', meta: { call: { duration: null, status: 'failed' } } } as GhlMessage).state).toBe('failed')
    // "ringing" is a transient/unconnected state with no LI equivalent → unknown.
    const ringing = extractGhlCall({ id: 'c', meta: { call: { duration: null, status: 'ringing' } } } as GhlMessage)
    expect(ringing.state).toBe('unknown')
    expect(ringing.durationSec).toBeNull()
  })

  it('classifies further GHL call statuses and falls back to top-level status', () => {
    expect(extractGhlCall({ id: 'd', meta: { call: { status: 'voicemail' } } } as GhlMessage).state).toBe('voicemail')
    expect(extractGhlCall({ id: 'e', meta: { call: { status: 'busy' } } } as GhlMessage).state).toBe('busy')
    // Top-level status mirrors meta.call.status on outbound rows; used when meta.call is absent.
    expect(extractGhlCall({ id: 'f', status: 'no-answer' } as GhlMessage).state).toBe('no_answer')
  })

  it('leaves recording null (endpoint omits it) but reads meta.call.recordingUrl if a revision adds it', () => {
    // Conversations messages never carry a recording today → null, unknown, null.
    const bare = extractGhlCall({ id: 'g' } as GhlMessage)
    expect(bare.recordingUrl).toBeNull()
    expect(bare.state).toBe('unknown')
    expect(bare.durationSec).toBeNull()
    // Forward-compat: if GHL nests a recording alongside duration/status, surface it.
    const withRec = extractGhlCall({ id: 'h', meta: { call: { status: 'completed', recordingUrl: 'https://x/r.mp3' } } } as GhlMessage)
    expect(withRec.recordingUrl).toBe('https://x/r.mp3')
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
