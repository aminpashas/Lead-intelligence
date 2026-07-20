import { describe, it, expect } from 'vitest'
import { computeEligibility, type LeadConsentRow } from '@/lib/campaigns/eligibility'

describe('computeEligibility (sms)', () => {
  // Consent is assumed — the only exclusions are opt-out (DND) and missing contact.
  const rows: LeadConsentRow[] = [
    { sms_consent: true, sms_opt_out: false, phone_formatted: 'enc::x' },   // eligible
    { sms_consent: true, sms_opt_out: false, phone_formatted: null },       // no_contact
    { sms_consent: false, sms_opt_out: false, phone_formatted: 'enc::x' },  // eligible (consent assumed)
    { sms_consent: true, sms_opt_out: true, phone_formatted: 'enc::x' },    // opted_out
    { sms_consent: false, sms_opt_out: true, phone_formatted: null },       // opted_out (priority)
  ]

  it('tallies each bucket with mutually exclusive reasons', () => {
    const e = computeEligibility(rows, 'sms')
    expect(e).toEqual({ total: 5, eligible: 2, no_consent: 0, opted_out: 2, no_contact: 1, on_hold: 0 })
  })

  it('buckets sum to total minus eligible', () => {
    const e = computeEligibility(rows, 'sms')
    expect(e.no_consent + e.opted_out + e.no_contact).toBe(e.total - e.eligible)
  })

  it('never populates the legacy no_consent bucket', () => {
    const e = computeEligibility(rows, 'sms')
    expect(e.no_consent).toBe(0)
  })

  it('empty input is all zeros', () => {
    expect(computeEligibility([], 'sms')).toEqual({ total: 0, eligible: 0, no_consent: 0, opted_out: 0, no_contact: 0, on_hold: 0 })
  })
})

describe('computeEligibility (email)', () => {
  it('uses the email opt-out/address columns (consent assumed)', () => {
    const rows: LeadConsentRow[] = [
      { email_consent: true, email_opt_out: false, email: 'enc::a' },  // eligible
      { email_consent: true, email_opt_out: false, email: null },      // no_contact
      { email_consent: false, email_opt_out: false, email: 'enc::b' }, // eligible (consent assumed)
    ]
    expect(computeEligibility(rows, 'email')).toEqual({ total: 3, eligible: 2, no_consent: 0, opted_out: 0, no_contact: 1, on_hold: 0 })
  })
})

describe('computeEligibility on_hold bucket', () => {
  it('counts a held lead as on_hold, not eligible', () => {
    const future = '2999-01-01T00:00:00Z'
    const out = computeEligibility(
      [{ sms_opt_out: false, phone_formatted: 'x', hold_until: future }],
      'sms',
    )
    expect(out.eligible).toBe(0)
    expect(out.on_hold).toBe(1)
  })

  it('buckets still sum to total - eligible', () => {
    const future = '2999-01-01T00:00:00Z'
    const leads = [
      { sms_opt_out: false, phone_formatted: 'x', hold_until: null },
      { sms_opt_out: true, phone_formatted: 'x', hold_until: null },
      { sms_opt_out: false, phone_formatted: null, hold_until: null },
      { sms_opt_out: false, phone_formatted: 'x', hold_until: future },
    ]
    const out = computeEligibility(leads, 'sms')
    expect(out.on_hold + out.opted_out + out.no_contact + out.no_consent)
      .toBe(out.total - out.eligible)
  })
})
