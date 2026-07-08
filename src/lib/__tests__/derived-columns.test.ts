import { describe, it, expect } from 'vitest'
import {
  DERIVED_COLUMNS,
  isDerivedColumnKey,
  matchesDerivedColumn,
} from '@/lib/pipeline/derived-columns'
import type { Lead } from '@/types/database'

// Minimal lead factory — only the fields the derived predicates read.
function lead(overrides: Partial<Lead>): Lead {
  return {
    status: 'contacted',
    financing_approved: null,
    first_contact_at: null,
    last_responded_at: null,
    financial_qualification_status: null,
    financial_qualification_tier: null,
    ...overrides,
  } as Lead
}

describe('financing-approved derived column', () => {
  const cutoff = Date.parse('2026-07-01T00:00:00Z')

  it('is a registered, URL-safe column key', () => {
    expect(DERIVED_COLUMNS.some((c) => c.key === 'financing-approved')).toBe(true)
    expect(isDerivedColumnKey('financing-approved')).toBe(true)
  })

  it('matches an approved lead that has not proceeded to close', () => {
    expect(
      matchesDerivedColumn(lead({ financing_approved: true }), 'financing-approved', cutoff)
    ).toBe(true)
  })

  it('excludes leads with no financing approval', () => {
    expect(
      matchesDerivedColumn(lead({ financing_approved: false }), 'financing-approved', cutoff)
    ).toBe(false)
    expect(
      matchesDerivedColumn(lead({ financing_approved: null }), 'financing-approved', cutoff)
    ).toBe(false)
  })

  it('drops approved leads that are dead (disqualified/lost)', () => {
    for (const status of ['disqualified', 'lost'] as const) {
      expect(
        matchesDerivedColumn(
          lead({ financing_approved: true, status }),
          'financing-approved',
          cutoff
        )
      ).toBe(false)
    }
  })
})
