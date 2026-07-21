import { describe, it, expect } from 'vitest'
import { stripEmailUnsubscribeFooter } from '@/lib/messaging/email-cleanup'

// A representative GHL unsubscribe URL (host + path are what we anchor on). The
// query string carries the recipient email, message id, timestamp and GHL's own
// signed unsubscribe JWT — all of which should be removed from the thread body.
const GHL_UNSUB_URL =
  'https://services.msgsndr.com/emails/builder/unsubscribe-view/tCQuemUxY4FdXOZh18ip/1hCSpWLdCTkSUno4HJVn' +
  '?email=spicycbrown%40yahoo.com&message_id=NQGUGXLRXeHxAyZA3P7L&time_stamp=1784627248171' +
  '&token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbSI6InNwaWN5Y2Jyb3duQHlhaG9vLmNvbSJ9.AYYhoSRUrdXODET7vM0C30GWeLy8JsIfTUCoSetVd8I'

describe('stripEmailUnsubscribeFooter', () => {
  it('strips the full GHL footer (sentence + bracketed link) from an email body', () => {
    const body =
      'Hi Carol,\n\nThank you for reaching out to Dion Health.\n\n' +
      'If you no longer wish to receive these emails you may unsubscribe\n' +
      `[${GHL_UNSUB_URL}]`
    const out = stripEmailUnsubscribeFooter(body)
    expect(out).toBe('Hi Carol,\n\nThank you for reaching out to Dion Health.')
    expect(out).not.toContain('msgsndr.com')
    expect(out).not.toContain('token=')
    expect(out).not.toContain('unsubscribe')
  })

  it('strips the link even without the leading sentence or brackets', () => {
    const body = `Welcome!\n\n${GHL_UNSUB_URL}`
    expect(stripEmailUnsubscribeFooter(body)).toBe('Welcome!')
  })

  it('leaves a body with no GHL footer untouched', () => {
    const body = 'Hi Carol,\n\nCan we book you Tuesday at 2pm?'
    expect(stripEmailUnsubscribeFooter(body)).toBe(body)
  })

  it('does not touch an unrelated bracketed link the writer added', () => {
    const body = 'See our reviews here:\n[https://g.page/dion-health/review]'
    expect(stripEmailUnsubscribeFooter(body)).toBe(body)
  })

  it('is safe on empty / null / undefined', () => {
    expect(stripEmailUnsubscribeFooter('')).toBe('')
    expect(stripEmailUnsubscribeFooter(null)).toBe('')
    expect(stripEmailUnsubscribeFooter(undefined)).toBe('')
  })
})
