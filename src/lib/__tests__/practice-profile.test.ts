import { describe, it, expect } from 'vitest'
import {
  profileCorePatchSchema,
  deepMergeProfileSection,
  SERVICE_LINE_SLUGS,
} from '@/lib/validators/practice-profile'

describe('deepMergeProfileSection', () => {
  it('merges a patch without clobbering sibling sections or fields', () => {
    const existing = {
      pricing: { consult_fee_text: '$150, credited toward treatment' },
      technology: { ehr: 'CareStack' },
    }
    const patch = { pricing: { financing_partners: ['Cherry', 'Proceed'] } }
    const merged = deepMergeProfileSection(existing, patch)
    expect(merged.pricing).toEqual({
      consult_fee_text: '$150, credited toward treatment',
      financing_partners: ['Cherry', 'Proceed'],
    })
    expect(merged.technology).toEqual({ ehr: 'CareStack' })
  })

  it('replaces arrays wholesale instead of concatenating', () => {
    const merged = deepMergeProfileSection(
      { preferences: { never_say: ['cheap'] } },
      { preferences: { never_say: ['discount', 'deal'] } }
    )
    expect((merged.preferences as Record<string, unknown>).never_say).toEqual([
      'discount',
      'deal',
    ])
  })

  it('deletes a key when the patch value is null', () => {
    const merged = deepMergeProfileSection(
      { operations: { walk_ins: true, notes: 'ask for Maria' } },
      { operations: { notes: null } }
    )
    expect(merged.operations).toEqual({ walk_ins: true })
  })

  it('does not mutate its inputs', () => {
    const existing = { hours: { timezone: 'America/Los_Angeles' } }
    deepMergeProfileSection(existing, { hours: { weekly_text: 'M-F 8-5' } })
    expect(existing).toEqual({ hours: { timezone: 'America/Los_Angeles' } })
  })
})

describe('profileCorePatchSchema', () => {
  it('accepts a valid partial patch', () => {
    const result = profileCorePatchSchema.safeParse({
      appointments: { consult_duration_minutes: 60, types: ['in_person', 'virtual'] },
      pricing: { financing_posture: 'financing-first, multi-lender' },
    })
    expect(result.success).toBe(true)
  })

  it('rejects unknown sections', () => {
    expect(profileCorePatchSchema.safeParse({ nonsense: { a: 1 } }).success).toBe(false)
  })

  it('rejects wrong-typed fields inside a section', () => {
    expect(
      profileCorePatchSchema.safeParse({
        appointments: { consult_duration_minutes: 'sixty' },
      }).success
    ).toBe(false)
  })

  it('exposes the four v1 service line slugs', () => {
    expect(SERVICE_LINE_SLUGS).toEqual(['implants', 'veneers', 'tmj', 'sleep_apnea'])
  })
})
