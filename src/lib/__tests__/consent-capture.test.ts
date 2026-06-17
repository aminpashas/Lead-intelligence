import { describe, it, expect } from 'vitest'
import {
  generateConsentToken,
  consentTokenExpiry,
  isTokenUsable,
  buildOptInUrl,
  consentGrantFields,
  optInEmailTemplate,
  CONSENT_TOKEN_TTL_HOURS,
} from '@/lib/consent/capture'

describe('generateConsentToken', () => {
  it('is url-safe and high-entropy', () => {
    const t = generateConsentToken()
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(t.length).toBeGreaterThanOrEqual(30)
  })
  it('is unique across calls', () => {
    expect(generateConsentToken()).not.toBe(generateConsentToken())
  })
})

describe('consentTokenExpiry', () => {
  it('is TTL hours in the future', () => {
    const now = new Date('2026-06-17T00:00:00.000Z')
    const exp = new Date(consentTokenExpiry(now)).getTime()
    expect(exp - now.getTime()).toBe(CONSENT_TOKEN_TTL_HOURS * 3600 * 1000)
  })
})

describe('isTokenUsable', () => {
  const future = '2026-12-31T00:00:00.000Z'
  const past = '2020-01-01T00:00:00.000Z'

  it('pending + not expired → usable', () => {
    expect(isTokenUsable({ status: 'pending', expires_at: future }).usable).toBe(true)
  })
  it('confirmed → already_used', () => {
    const r = isTokenUsable({ status: 'confirmed', expires_at: future })
    expect(r).toEqual({ usable: false, reason: 'already_used' })
  })
  it('past expiry → expired', () => {
    const r = isTokenUsable({ status: 'pending', expires_at: past })
    expect(r).toEqual({ usable: false, reason: 'expired' })
  })
})

describe('buildOptInUrl', () => {
  it('joins base + token, trimming trailing slash', () => {
    expect(buildOptInUrl('https://app.example.com/', 'abc')).toBe('https://app.example.com/optin/abc')
    expect(buildOptInUrl('https://app.example.com', 'abc')).toBe('https://app.example.com/optin/abc')
  })
})

describe('consentGrantFields', () => {
  const NOW = '2026-06-17T12:00:00.000Z'
  it('sets only the requested channels, always to true', () => {
    const f = consentGrantFields(['sms'], NOW)
    expect(f.sms_consent).toBe(true)
    expect(f.sms_consent_at).toBe(NOW)
    expect(f.sms_consent_source).toBe('optin_page')
    expect(f.email_consent).toBeUndefined()
  })
  it('handles both channels', () => {
    const f = consentGrantFields(['sms', 'email'], NOW)
    expect(f.sms_consent).toBe(true)
    expect(f.email_consent).toBe(true)
  })
})

describe('optInEmailTemplate', () => {
  it('includes the confirm url and org name, and opt-out language', () => {
    const t = optInEmailTemplate({ orgName: 'Dion Health', firstName: 'Sam', url: 'https://x/optin/t' })
    expect(t.html).toContain('https://x/optin/t')
    expect(t.text).toContain('https://x/optin/t')
    expect(t.html).toContain('Dion Health')
    expect(t.text.toLowerCase()).toContain('stop')
  })
  it('falls back gracefully when name/org missing', () => {
    const t = optInEmailTemplate({ orgName: '', url: 'https://x/optin/t' })
    expect(t.text).toContain('there')
    expect(t.subject).toContain('our team')
  })
})
