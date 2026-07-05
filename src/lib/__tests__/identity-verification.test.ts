import { describe, it, expect } from 'vitest'
import {
  hasCaseData,
  verifyDob,
  isVerificationActive,
  canDisclosePHI,
} from '../ai/identity-verification'

describe('hasCaseData', () => {
  it('is false for a fresh ad lead (form fields only)', () => {
    expect(
      hasCaseData({
        status: 'new',
        first_name: 'Jane',
        dental_condition: 'missing_all_upper', // ad-form field — must NOT trip the gate
        budget_range: '10k_20k',
        credit_range: 'good',
      }),
    ).toBe(false)
  })

  it('is true once a consult is booked', () => {
    expect(hasCaseData({ status: 'qualified', consultation_date: '2026-07-10T15:00:00Z' })).toBe(true)
  })

  it('is true with a financing application on file', () => {
    expect(hasCaseData({ status: 'contacted', financing_application_id: 'app_123' })).toBe(true)
  })

  it('is true with insurance on file', () => {
    expect(hasCaseData({ status: 'contacted', insurance_provider: 'Delta Dental' })).toBe(true)
  })

  it('is true for an advanced pipeline stage', () => {
    expect(hasCaseData({ status: 'treatment_presented' })).toBe(true)
    expect(hasCaseData({ status: 'no_show' })).toBe(true) // implies a booked consult
  })

  it('treats empty/unknown sentinels as no data', () => {
    expect(hasCaseData({ status: 'new', insurance_provider: '', consultation_date: null })).toBe(false)
  })
})

describe('verifyDob', () => {
  // decryptField passes plaintext through, so a bare ISO string stands in for the
  // stored (encrypted) value in these tests.
  const onFile = '1980-03-05'

  it('matches ISO stored vs US-spoken formats', () => {
    expect(verifyDob('3/5/1980', onFile)).toBe(true)
    expect(verifyDob('03/05/1980', onFile)).toBe(true)
    expect(verifyDob('March 5, 1980', onFile)).toBe(true)
    expect(verifyDob('march 5 1980', onFile)).toBe(true)
    expect(verifyDob('5th of March 1980', onFile)).toBe(true)
  })

  it('tolerates a time suffix on the stored value', () => {
    expect(verifyDob('3/5/1980', '1980-03-05T00:00:00Z')).toBe(true)
  })

  it('rejects a wrong date', () => {
    expect(verifyDob('3/6/1980', onFile)).toBe(false)
    expect(verifyDob('March 5, 1981', onFile)).toBe(false)
  })

  it('fails closed on ambiguous / unparseable input', () => {
    expect(verifyDob('3/5/80', onFile)).toBe(false) // 2-digit year
    expect(verifyDob('sometime in 1980', onFile)).toBe(false)
    expect(verifyDob('', onFile)).toBe(false)
  })

  it('fails when there is no DOB on file', () => {
    expect(verifyDob('3/5/1980', null)).toBe(false)
    expect(verifyDob('3/5/1980', undefined)).toBe(false)
  })
})

describe('isVerificationActive', () => {
  it('is false without a timestamp', () => {
    expect(isVerificationActive(null, 'voice')).toBe(false)
  })

  it('honors the voice TTL (15m)', () => {
    const fresh = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString()
    expect(isVerificationActive(fresh, 'voice')).toBe(true)
    expect(isVerificationActive(stale, 'voice')).toBe(false)
  })

  it('honors the shorter sms TTL (30m) for non-voice channels', () => {
    const stale = new Date(Date.now() - 40 * 60 * 1000).toISOString()
    expect(isVerificationActive(stale, 'sms')).toBe(false)
    expect(isVerificationActive(stale, 'email')).toBe(false)
  })
})

describe('canDisclosePHI', () => {
  it('allows disclosure for a fresh lead regardless of verification', () => {
    expect(canDisclosePHI({ lead: { status: 'new' }, verifiedAt: null, channel: 'sms' })).toBe(true)
  })

  it('blocks disclosure for a real patient until verified', () => {
    const lead = { status: 'treatment_presented' }
    expect(canDisclosePHI({ lead, verifiedAt: null, channel: 'voice' })).toBe(false)
    const fresh = new Date().toISOString()
    expect(canDisclosePHI({ lead, verifiedAt: fresh, channel: 'voice' })).toBe(true)
  })
})
