import { describe, it, expect } from 'vitest'
import { classifyGhlSendError } from '@/lib/ghl/social-send-guards'
import { sendBlockMessage } from '@/lib/messaging/send-block-messages'
import { socialWindowState, suggestFallback } from '@/lib/messaging/social-window'

// Verbatim from the two failing sends, exactly as client.ts:160 builds them.
const BARBARA = `GHL 400 /conversations/messages: {"statusCode":400,"error":"Bad Request","message":"Can't send Facebook message as the last inbound message was earlier than 24 hours ago and there is no Facebook comment.","canonicalCode":"CONVERSATIONS_MSG_CHAT_NO_LONGER_ACTIVE","arguments":{"channel":"Facebook"},"traceId":"c1d407fb-9887-4f23-9711-`
const ELLEN = BARBARA.replace('c1d407fb-9887-4f23-9711-', 'fbc9d09c-dfc0-4aa5-8519-')

describe('the two live failures', () => {
  it('classifies both as the window, not a 500', () => {
    for (const raw of [BARBARA, ELLEN]) {
      const r = classifyGhlSendError(raw)
      expect(r.reason).toBe('social_window_closed')
      expect(r.status).toBe(409)
    }
  })
  it('shows friendly copy, never the raw JSON', () => {
    const msg = sendBlockMessage(classifyGhlSendError(BARBARA), 'Failed to send message')
    expect(msg).toContain('24 hours')
    expect(msg).not.toContain('canonicalCode')
    expect(msg).not.toContain('GHL 400')
  })
  it('still lets a real scope failure and an unknown error through', () => {
    expect(classifyGhlSendError('GHL 401 ...: not authorized for this scope').reason).toBe('ghl_scope_missing')
    expect(classifyGhlSendError('GHL 500 ...: boom').reason).toBe('ghl_send_failed')
  })
})

describe('pre-send window state', () => {
  const NOW = new Date('2026-07-20T12:00:00Z').getTime()
  const at = (iso: string, direction: string) => ({ direction, created_at: iso })

  it('Barbara: all outbound -> never opened', () => {
    expect(socialWindowState([
      at('2026-07-17T21:30:00Z', 'outbound'),
      at('2026-07-19T18:19:00Z', 'outbound'),
    ], NOW)).toEqual({ status: 'never_opened' })
  })

  it('Ellen: last inbound Jul 17 -> closed', () => {
    const s = socialWindowState([
      at('2026-07-17T21:36:00Z', 'inbound'),
      at('2026-07-17T21:37:00Z', 'outbound'),
    ], NOW)
    expect(s.status).toBe('closed')
  })

  it('a reply 2h ago reopens it', () => {
    const s = socialWindowState([at('2026-07-20T10:00:00Z', 'inbound')], NOW)
    expect(s.status).toBe('open')
    expect(s.status === 'open' && Math.round(s.hoursLeft)).toBe(22)
  })

  it('picks the LATEST inbound, not the last in array order', () => {
    const s = socialWindowState([
      at('2026-07-20T11:00:00Z', 'inbound'),
      at('2026-01-01T00:00:00Z', 'inbound'),
    ], NOW)
    expect(s.status).toBe('open')
  })

  it('ignores unparseable timestamps instead of returning NaN', () => {
    expect(socialWindowState([at('not-a-date', 'inbound')], NOW).status).toBe('never_opened')
  })
})

describe('fallback channel suggestion', () => {
  it('prefers a text when a phone is on file', () => {
    expect(suggestFallback({ phone: '+14155550123', email: 'h@example.com' }))
      .toEqual({ channel: 'sms', label: 'a text' })
  })
  it('falls back to email when there is no phone', () => {
    expect(suggestFallback({ phone: null, email: 'h@example.com' }))
      .toEqual({ channel: 'email', label: 'email' })
  })
  it('returns null for a DM-only lead with nothing on file', () => {
    // Barbara's case — this is what drives the "add a phone or email" prompt.
    expect(suggestFallback({ phone: null, email: null })).toBeNull()
  })
})
