import { describe, it, expect } from 'vitest'
import { vi } from 'vitest'
import {
  resolvePracticeContact,
  formatPracticeContactBlock,
  buildPracticeContactBlock,
} from '@/lib/ai/practice-contact'
import {
  detectPHI,
  scrubPHI,
  filterAllowlistedDetections,
  checkResponseCompliance,
} from '@/lib/ai/hipaa'

/**
 * Regression: the setter texted a patient "Call us anytime: [practice phone]"
 * because the agent system prompt never carried the practice's real number.
 * These tests pin the contract: when the org has a phone on file, the block
 * that gets joined into the setter/closer system prompt contains that phone
 * verbatim — and in every case it contains the placeholder ban.
 */

// Mock Supabase covering the two tables the resolver reads:
// practice_content_assets (via getPracticeInfo) and organizations (fallback).
function mockSupabase(opts: {
  assetContent?: Record<string, unknown> | null
  org?: { phone?: string | null; address?: Record<string, string> | null } | null
}) {
  return {
    from: vi.fn((table: string) => {
      if (table === 'practice_content_assets') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockResolvedValue({
            data: opts.assetContent
              ? [{ id: 'asset-1', type: 'practice_info', content: opts.assetContent }]
              : [],
          }),
        }
      }
      if (table === 'organizations') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: opts.org ?? null }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  } as any
}

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c'

describe('resolvePracticeContact', () => {
  it('reads phone/address/hours from the practice_info asset', async () => {
    const supabase = mockSupabase({
      assetContent: {
        phone: '(415) 555-0134',
        address: '450 Sutter St Suite 2530',
        city: 'San Francisco',
        state: 'CA',
        zip: '94108',
        hours: 'Mon-Fri 8am-5pm',
      },
    })

    const contact = await resolvePracticeContact(supabase, ORG_ID)
    expect(contact.phone).toBe('(415) 555-0134')
    expect(contact.address).toBe('450 Sutter St Suite 2530, San Francisco, CA, 94108')
    expect(contact.hours).toBe('Mon-Fri 8am-5pm')
  })

  it('falls back to the organizations row when no practice_info asset exists', async () => {
    // Mirrors the real Dion Health SF org row: phone + {street, postal_code}
    // address JSON (postal_code, not zip) and no practice_info asset at all.
    const supabase = mockSupabase({
      assetContent: null,
      org: {
        phone: '+15104089331',
        address: { street: '450 Sutter St Suite 1519', city: 'San Francisco', state: 'CA', postal_code: '94108' },
      },
    })

    const contact = await resolvePracticeContact(supabase, ORG_ID)
    expect(contact.phone).toBe('+15104089331')
    expect(contact.address).toBe('450 Sutter St Suite 1519, San Francisco, CA, 94108')
    expect(contact.hours).toBeNull()
  })

  it('returns nulls when neither source has contact info', async () => {
    const supabase = mockSupabase({ assetContent: null, org: null })
    const contact = await resolvePracticeContact(supabase, ORG_ID)
    expect(contact).toEqual({ phone: null, address: null, hours: null })
  })
})

describe('practice contact prompt block', () => {
  it('contains the real practice phone when the org has one', async () => {
    const supabase = mockSupabase({ assetContent: { phone: '(415) 555-0134' } })
    const block = await buildPracticeContactBlock(supabase, ORG_ID)

    expect(block).toContain('Practice phone: (415) 555-0134')
    expect(block).toContain('use these EXACT values')
  })

  it('always includes the placeholder ban — with or without a phone on file', () => {
    const withPhone = formatPracticeContactBlock({
      phone: '(415) 555-0134', address: null, hours: null,
    })
    const withoutPhone = formatPracticeContactBlock({
      phone: null, address: null, hours: null,
    })

    for (const block of [withPhone, withoutPhone]) {
      expect(block).toContain('PLACEHOLDER BAN')
      expect(block).toContain('[practice phone]')
      expect(block).toContain('never write a placeholder')
    }
    // No phone on file → explicit instruction not to invent one.
    expect(withoutPhone).toContain('Do NOT invent')
    expect(withoutPhone).not.toContain('Practice phone:')
  })
})

describe('practice contact vs PHI output scrubbing', () => {
  // Without the allowlist, the output compliance pass would redact the real
  // practice number the prompt just told the agent to use — trading
  // "[practice phone]" for "[PHONE_REDACTED]" in the patient-visible SMS.
  const PRACTICE_PHONE = '+15104089331'
  const reply = 'Sounds good! Call us anytime at (510) 408-9331 and we can get you scheduled.'

  it('does not flag or scrub the practice phone when allowlisted', () => {
    const issues = checkResponseCompliance(reply, { allowlist: [PRACTICE_PHONE] })
    expect(issues.filter((i) => i.category === 'phi_exposure')).toHaveLength(0)

    const scrubbed = scrubPHI(reply, filterAllowlistedDetections(detectPHI(reply), [PRACTICE_PHONE]))
    expect(scrubbed).toContain('(510) 408-9331')
    expect(scrubbed).not.toContain('[PHONE_REDACTED]')
  })

  it('still flags and scrubs non-practice (patient) phone numbers', () => {
    const leaky = 'Sure — I have your number as (415) 111-2222, and you can reach us at (510) 408-9331.'
    const issues = checkResponseCompliance(leaky, { allowlist: [PRACTICE_PHONE] })
    expect(issues.some((i) => i.category === 'phi_exposure')).toBe(true)

    const scrubbed = scrubPHI(leaky, filterAllowlistedDetections(detectPHI(leaky), [PRACTICE_PHONE]))
    expect(scrubbed).toContain('[PHONE_REDACTED]')
    expect(scrubbed).toContain('(510) 408-9331')
  })
})
