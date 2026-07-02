import { describe, it, expect } from 'vitest'
import {
  parseGoogleLeadColumns,
  hasGoogleContact,
  isGoogleTestLead,
  verifyGoogleKey,
} from '@/lib/connectors/google-ads/lead-forms'

describe('parseGoogleLeadColumns', () => {
  it('parses native user_column_data', () => {
    const p = parseGoogleLeadColumns({
      user_column_data: [
        { column_id: 'FULL_NAME', string_value: 'Jane Doe' },
        { column_id: 'EMAIL', string_value: 'jane@example.com' },
        { column_id: 'PHONE_NUMBER', string_value: '+15125551234' },
        { column_id: 'CITY', string_value: 'Austin' },
        { column_id: 'POSTAL_CODE', string_value: '78701' },
      ],
    })
    expect(p.firstName).toBe('Jane')
    expect(p.lastName).toBe('Doe')
    expect(p.email).toBe('jane@example.com')
    expect(p.phone).toBe('+15125551234')
    expect(p.city).toBe('Austin')
    expect(p.zip).toBe('78701')
  })

  it('prefers explicit FIRST_NAME/LAST_NAME columns', () => {
    const p = parseGoogleLeadColumns({
      user_column_data: [
        { column_id: 'FIRST_NAME', string_value: 'Sam' },
        { column_id: 'LAST_NAME', string_value: 'Rivera' },
        { column_id: 'EMAIL', string_value: 'sam@x.com' },
      ],
    })
    expect(p.firstName).toBe('Sam')
    expect(p.lastName).toBe('Rivera')
  })

  it('handles a flattened relay shape', () => {
    const p = parseGoogleLeadColumns({ full_name: 'Al Bee', phone: '5551234567' })
    expect(p.firstName).toBe('Al')
    expect(p.lastName).toBe('Bee')
    expect(p.phone).toBe('5551234567')
    expect(hasGoogleContact(p)).toBe(true)
  })

  it('placeholder name + no contact when empty', () => {
    const p = parseGoogleLeadColumns({ user_column_data: [{ column_id: 'CITY', string_value: 'Austin' }] })
    expect(p.firstName).toBe('Google Lead')
    expect(hasGoogleContact(p)).toBe(false)
  })
})

describe('isGoogleTestLead', () => {
  it('detects boolean and string true', () => {
    expect(isGoogleTestLead({ is_test: true })).toBe(true)
    expect(isGoogleTestLead({ is_test: 'true' })).toBe(true)
  })
  it('false/absent are not tests', () => {
    expect(isGoogleTestLead({ is_test: false })).toBe(false)
    expect(isGoogleTestLead({})).toBe(false)
  })
})

describe('verifyGoogleKey', () => {
  it('accepts an exact match', () => {
    expect(verifyGoogleKey('s3cret-key', 's3cret-key')).toBe(true)
  })
  it('rejects a mismatch, wrong length, or missing key', () => {
    expect(verifyGoogleKey('nope', 's3cret-key')).toBe(false)
    expect(verifyGoogleKey('', 's3cret-key')).toBe(false)
    expect(verifyGoogleKey(undefined, 's3cret-key')).toBe(false)
  })
})
