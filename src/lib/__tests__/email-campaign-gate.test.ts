import { describe, it, expect } from 'vitest'
import { emailCampaignGate } from '@/lib/consent/gate'

describe('emailCampaignGate', () => {
  describe('without the re-permission override (default)', () => {
    it('allows a consented lead', () => {
      const r = emailCampaignGate(
        { email_consent: true, email_opt_out: false, email_consent_status: 'granted' },
        { allowUnconsented: false }
      )
      expect(r).toEqual({ allowed: true, usedOverride: false })
    })

    it('denies a consent-unknown lead', () => {
      const r = emailCampaignGate(
        { email_consent: null, email_opt_out: null, email_consent_status: 'unknown' },
        { allowUnconsented: false }
      )
      expect(r).toEqual({ allowed: false, reason: 'no_consent' })
    })

    it('denies an opted-out lead', () => {
      const r = emailCampaignGate(
        { email_consent: true, email_opt_out: true, email_consent_status: 'granted' },
        { allowUnconsented: false }
      )
      expect(r).toEqual({ allowed: false, reason: 'opted_out' })
    })
  })

  describe('with the re-permission override', () => {
    it('allows a consent-unknown lead and flags the override for audit', () => {
      const r = emailCampaignGate(
        { email_consent: null, email_opt_out: null, email_consent_status: 'unknown' },
        { allowUnconsented: true }
      )
      expect(r).toEqual({ allowed: true, usedOverride: true })
    })

    it('treats a null consent status like unknown (legacy rows)', () => {
      const r = emailCampaignGate(
        { email_consent: false, email_opt_out: false, email_consent_status: null },
        { allowUnconsented: true }
      )
      expect(r).toEqual({ allowed: true, usedOverride: true })
    })

    it('still denies an opted-out lead — opt-out is never overridable', () => {
      const r = emailCampaignGate(
        { email_consent: null, email_opt_out: true, email_consent_status: 'unknown' },
        { allowUnconsented: true }
      )
      expect(r).toEqual({ allowed: false, reason: 'opted_out' })
    })

    it('still denies a declined lead — an explicit "no" is never overridable', () => {
      const r = emailCampaignGate(
        { email_consent: false, email_opt_out: false, email_consent_status: 'declined' },
        { allowUnconsented: true }
      )
      expect(r).toEqual({ allowed: false, reason: 'declined' })
    })

    it('does not mark consented leads as overridden', () => {
      const r = emailCampaignGate(
        { email_consent: true, email_opt_out: false, email_consent_status: 'granted' },
        { allowUnconsented: true }
      )
      expect(r).toEqual({ allowed: true, usedOverride: false })
    })
  })

  it('boolean consent gate wins over a contradictory declined status', () => {
    // The booleans are the send gate's source of truth (see gate.ts header);
    // a stale 'declined' status must not block a lead whose consent boolean is true.
    const r = emailCampaignGate(
      { email_consent: true, email_opt_out: false, email_consent_status: 'declined' },
      { allowUnconsented: false }
    )
    expect(r).toEqual({ allowed: true, usedOverride: false })
  })
})
