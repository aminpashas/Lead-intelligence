import { describe, it, expect } from 'vitest'
import { sanitizeCustomFields, mergeCustomFields, customFieldsDedupPatch } from '@/lib/leads/custom-fields'

describe('sanitizeCustomFields', () => {
  it('keeps allow-listed referral fields from a doctor-referral form', () => {
    // The exact shape observed on the ximalatl GHL contact.
    expect(sanitizeCustomFields({
      referring_doctor: 'Dr. Manali Rathod',
      referring_practice: 'The Dental Practice | SF',
      referral_reason: 'TMJ',
      referral_clinical_note: 'Pt. has increased popping upon opening.',
    })).toEqual({
      referring_doctor: 'Dr. Manali Rathod',
      referring_practice: 'The Dental Practice | SF',
      referral_reason: 'TMJ',
      referral_clinical_note: 'Pt. has increased popping upon opening.',
    })
  })

  it('drops keys not on the allow-list (no jsonb dumping ground)', () => {
    expect(sanitizeCustomFields({ referring_doctor: 'Dr. X', evil_key: 'nope', ssn: '123' }))
      .toEqual({ referring_doctor: 'Dr. X' })
  })

  it('joins string arrays (GHL multi-selects)', () => {
    expect(sanitizeCustomFields({ referral_reason: ['TMJ', 'Sleep Apnea'] }))
      .toEqual({ referral_reason: 'TMJ, Sleep Apnea' })
  })

  it('trims and ignores blank / non-string values', () => {
    expect(sanitizeCustomFields({ referring_doctor: '  Dr. Y  ', referral_reason: '', referral_priority: 5 }))
      .toEqual({ referring_doctor: 'Dr. Y' })
  })

  it('returns null for non-objects, arrays, and empty results', () => {
    expect(sanitizeCustomFields(null)).toBeNull()
    expect(sanitizeCustomFields('x')).toBeNull()
    expect(sanitizeCustomFields(['a'])).toBeNull()
    expect(sanitizeCustomFields({ unrelated: 'v' })).toBeNull()
  })
})

describe('mergeCustomFields', () => {
  it('derived treatment_interest wins over any incoming value', () => {
    expect(mergeCustomFields({ treatment_interest: 'implants', referring_doctor: 'Dr. Z' }, 'tmj'))
      .toEqual({ treatment_interest: 'tmj', referring_doctor: 'Dr. Z' })
  })

  it('keeps incoming fields when there is no derived service line', () => {
    expect(mergeCustomFields({ referring_doctor: 'Dr. Z' }, null))
      .toEqual({ referring_doctor: 'Dr. Z' })
  })

  it('stamps treatment_interest even with no incoming fields', () => {
    expect(mergeCustomFields(null, 'tmj')).toEqual({ treatment_interest: 'tmj' })
  })

  it('returns null when there is nothing to store', () => {
    expect(mergeCustomFields(null, null)).toBeNull()
  })
})

describe('customFieldsDedupPatch', () => {
  it('adds only the keys the existing lead is missing', () => {
    expect(customFieldsDedupPatch(
      { treatment_interest: 'tmj' },
      { referring_doctor: 'Dr. Manali Rathod', referral_reason: 'TMJ' },
    )).toEqual({ treatment_interest: 'tmj', referring_doctor: 'Dr. Manali Rathod', referral_reason: 'TMJ' })
  })

  it('never clobbers a value already set', () => {
    expect(customFieldsDedupPatch(
      { referring_doctor: 'Dr. Existing' },
      { referring_doctor: 'Dr. New', referral_reason: 'TMJ' },
    )).toEqual({ referring_doctor: 'Dr. Existing', referral_reason: 'TMJ' })
  })

  it('treats blank/undefined existing values as fillable', () => {
    expect(customFieldsDedupPatch(
      { referring_doctor: '' },
      { referring_doctor: 'Dr. New' },
    )).toEqual({ referring_doctor: 'Dr. New' })
  })

  it('returns null when nothing new would be added', () => {
    expect(customFieldsDedupPatch({ referring_doctor: 'Dr. X' }, { referring_doctor: 'Dr. Y' })).toBeNull()
    expect(customFieldsDedupPatch({ a: 1 }, null)).toBeNull()
    expect(customFieldsDedupPatch({ a: 1 }, {})).toBeNull()
  })

  it('handles a null/absent existing custom_fields', () => {
    expect(customFieldsDedupPatch(null, { referring_doctor: 'Dr. X' }))
      .toEqual({ referring_doctor: 'Dr. X' })
  })
})
