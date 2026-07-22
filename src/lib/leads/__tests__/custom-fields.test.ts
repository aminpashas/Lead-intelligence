import { describe, it, expect } from 'vitest'
import { sanitizeCustomFields, mergeCustomFields, customFieldsDedupPatch, CUSTOM_FIELD_KEYS } from '@/lib/leads/custom-fields'

// TRIPWIRE — this allow-list is one half of a CROSS-REPO contract. The other
// half is GHL_REFERRAL_FIELD_IDS in dion-growth-studio
// (supabase/functions/ingest-gohighlevel/index.ts), which maps GHL custom-field
// ids onto these exact key names. A key present in one list but not the other is
// silently DROPPED — no error, the field just never appears on the lead. This
// test fails loudly on any edit so the DGS side gets updated in the same change.
describe('CUSTOM_FIELD_KEYS cross-repo contract', () => {
  it('matches dion-growth-studio GHL_REFERRAL_FIELD_IDS (update BOTH or fields vanish)', () => {
    expect([...CUSTOM_FIELD_KEYS].sort()).toEqual([
      'patient_dob',
      'referral_notes',
      'referral_reason',
      'referral_urgency',
      'referring_doctor_email',
      'referring_doctor_name',
      'referring_doctor_npi',
      'referring_doctor_phone',
      'referring_practice',
      'treatment_interest', // LI-derived, no DGS counterpart
    ])
  })
})

describe('sanitizeCustomFields', () => {
  it('keeps allow-listed referral fields from a doctor-referral form', () => {
    // The exact shape observed on the ximalatl GHL contact, keyed to the real
    // GHL custom-field definitions on the Dion Health location.
    expect(sanitizeCustomFields({
      referring_doctor_name: 'Dr. Manali Rathod',
      referring_doctor_npi: '1225394539',
      referring_practice: 'The Dental Practice | SF',
      referral_reason: 'TMJ',
      referral_urgency: 'Medium',
      referral_notes: 'Pt. has increased popping upon opening.',
      patient_dob: '1982-08-10',
    })).toEqual({
      referring_doctor_name: 'Dr. Manali Rathod',
      referring_doctor_npi: '1225394539',
      referring_practice: 'The Dental Practice | SF',
      referral_reason: 'TMJ',
      referral_urgency: 'Medium',
      referral_notes: 'Pt. has increased popping upon opening.',
      patient_dob: '1982-08-10',
    })
  })

  it('drops keys not on the allow-list (no jsonb dumping ground)', () => {
    expect(sanitizeCustomFields({ referring_doctor_name: 'Dr. X', evil_key: 'nope', ssn: '123' }))
      .toEqual({ referring_doctor_name: 'Dr. X' })
  })

  it('joins string arrays (GHL multi-selects)', () => {
    expect(sanitizeCustomFields({ referral_reason: ['TMJ', 'Sleep Apnea'] }))
      .toEqual({ referral_reason: 'TMJ, Sleep Apnea' })
  })

  it('trims and ignores blank / non-string values', () => {
    // referral_urgency IS allow-listed, so a numeric value proves the
    // non-string guard rather than merely being dropped by the allow-list.
    expect(sanitizeCustomFields({ referring_doctor_name: '  Dr. Y  ', referral_reason: '', referral_urgency: 5 }))
      .toEqual({ referring_doctor_name: 'Dr. Y' })
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
    expect(mergeCustomFields({ treatment_interest: 'implants', referring_doctor_name: 'Dr. Z' }, 'tmj'))
      .toEqual({ treatment_interest: 'tmj', referring_doctor_name: 'Dr. Z' })
  })

  it('keeps incoming fields when there is no derived service line', () => {
    expect(mergeCustomFields({ referring_doctor_name: 'Dr. Z' }, null))
      .toEqual({ referring_doctor_name: 'Dr. Z' })
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
      { referring_doctor_name: 'Dr. Manali Rathod', referral_reason: 'TMJ' },
    )).toEqual({ treatment_interest: 'tmj', referring_doctor_name: 'Dr. Manali Rathod', referral_reason: 'TMJ' })
  })

  it('never clobbers a value already set', () => {
    expect(customFieldsDedupPatch(
      { referring_doctor_name: 'Dr. Existing' },
      { referring_doctor_name: 'Dr. New', referral_reason: 'TMJ' },
    )).toEqual({ referring_doctor_name: 'Dr. Existing', referral_reason: 'TMJ' })
  })

  it('treats blank/undefined existing values as fillable', () => {
    expect(customFieldsDedupPatch(
      { referring_doctor_name: '' },
      { referring_doctor_name: 'Dr. New' },
    )).toEqual({ referring_doctor_name: 'Dr. New' })
  })

  it('returns null when nothing new would be added', () => {
    expect(customFieldsDedupPatch({ referring_doctor_name: 'Dr. X' }, { referring_doctor_name: 'Dr. Y' })).toBeNull()
    expect(customFieldsDedupPatch({ a: 1 }, null)).toBeNull()
    expect(customFieldsDedupPatch({ a: 1 }, {})).toBeNull()
  })

  it('handles a null/absent existing custom_fields', () => {
    expect(customFieldsDedupPatch(null, { referring_doctor_name: 'Dr. X' }))
      .toEqual({ referring_doctor_name: 'Dr. X' })
  })
})
