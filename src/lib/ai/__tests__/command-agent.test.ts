import { describe, it, expect } from 'vitest'
import {
  sanitizeCriteria,
  applyTimeFilters,
  smsEligible,
  emailEligible,
  type AudienceLead,
} from '@/lib/ai/command-agent'

function lead(overrides: Partial<AudienceLead> = {}): AudienceLead {
  return {
    id: 'lead-1',
    first_name: 'Jane',
    last_name: 'Doe',
    status: 'contacted',
    ai_qualification: 'hot',
    ai_score: 80,
    phone_formatted: '+15551234567',
    sms_consent: true,
    sms_opt_out: false,
    email: 'jane@example.com',
    email_consent: true,
    email_opt_out: false,
    last_contacted_at: null,
    last_responded_at: null,
    created_at: '2026-06-01T00:00:00Z',
    ...overrides,
  }
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

describe('sanitizeCriteria', () => {
  it('whitelists only real SmartListCriteria keys', () => {
    const c = sanitizeCriteria({
      statuses: ['new', 'contacted'],
      ai_qualifications: ['hot'],
      score_min: 50,
      organization_id: 'evil-other-org', // must be dropped
      has_phone: 'true', // wrong type + not whitelisted here — dropped
      limit: 999999,
    })
    expect(c).toEqual({ statuses: ['new', 'contacted'], ai_qualifications: ['hot'], score_min: 50 })
    expect('organization_id' in c).toBe(false)
  })

  it('normalizes keywords: caps terms at 10, defaults match/scopes, drops bad scopes', () => {
    const c = sanitizeCriteria({
      keywords: {
        terms: Array.from({ length: 15 }, (_, i) => `t${i}`),
        match: 'weird',
        scopes: ['tags', 'nonsense'],
      },
    })
    expect(c.keywords?.terms).toHaveLength(10)
    expect(c.keywords?.match).toBe('any')
    expect(c.keywords?.scopes).toEqual(['tags'])
  })

  it('defaults scopes when omitted', () => {
    const c = sanitizeCriteria({ keywords: { terms: ['implant'] } })
    expect(c.keywords?.scopes).toEqual(['lead_fields', 'conversation'])
  })
})

describe('applyTimeFilters', () => {
  it('not_contacted_in_days keeps never-contacted and stale-contacted leads', () => {
    const rows = [
      lead({ id: 'never', last_contacted_at: null }),
      lead({ id: 'stale', last_contacted_at: daysAgo(10) }),
      lead({ id: 'recent', last_contacted_at: daysAgo(1) }),
    ]
    const out = applyTimeFilters(rows, { not_contacted_in_days: 3 })
    expect(out.map((l) => l.id)).toEqual(['never', 'stale'])
  })

  it('awaiting_reply keeps contacted leads with no reply since last contact', () => {
    const rows = [
      lead({ id: 'no-reply', last_contacted_at: daysAgo(2), last_responded_at: null }),
      lead({ id: 'replied-before', last_contacted_at: daysAgo(2), last_responded_at: daysAgo(5) }),
      lead({ id: 'replied-after', last_contacted_at: daysAgo(5), last_responded_at: daysAgo(2) }),
      lead({ id: 'never-contacted', last_contacted_at: null }),
    ]
    const out = applyTimeFilters(rows, { awaiting_reply: true })
    expect(out.map((l) => l.id)).toEqual(['no-reply', 'replied-before'])
  })

  it('applies both filters together', () => {
    const rows = [
      lead({ id: 'match', last_contacted_at: daysAgo(10), last_responded_at: null }),
      lead({ id: 'too-recent', last_contacted_at: daysAgo(1), last_responded_at: null }),
    ]
    const out = applyTimeFilters(rows, { not_contacted_in_days: 3, awaiting_reply: true })
    expect(out.map((l) => l.id)).toEqual(['match'])
  })

  it('no filters → passthrough', () => {
    const rows = [lead()]
    expect(applyTimeFilters(rows, {})).toEqual(rows)
  })
})

describe('eligibility (consent assumed — only DND/opt-out blocks)', () => {
  it('sms requires phone + not opted out (consent assumed)', () => {
    expect(smsEligible(lead())).toBe(true)
    expect(smsEligible(lead({ phone_formatted: null }))).toBe(false)
    // Consent unknown / not granted still sends — only an opt-out blocks.
    expect(smsEligible(lead({ sms_consent: false }))).toBe(true)
    expect(smsEligible(lead({ sms_consent: null }))).toBe(true)
    expect(smsEligible(lead({ sms_opt_out: true }))).toBe(false)
  })

  it('email requires address + not opted out (consent assumed)', () => {
    expect(emailEligible(lead())).toBe(true)
    expect(emailEligible(lead({ email: null }))).toBe(false)
    expect(emailEligible(lead({ email_consent: false }))).toBe(true)
    expect(emailEligible(lead({ email_consent: null }))).toBe(true)
    expect(emailEligible(lead({ email_opt_out: true }))).toBe(false)
  })
})
