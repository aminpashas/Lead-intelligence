import { describe, it, expect } from 'vitest'
import { computeFollowUpTiming, type FollowUpTimingInput } from '@/lib/followup/timing'

const NOW = new Date('2026-07-10T00:00:00Z').getTime()

const lead = (o: Partial<FollowUpTimingInput> = {}): FollowUpTimingInput => ({
  last_contacted_at: null,
  last_responded_at: null,
  status: 'new',
  phone: '+15551234567',
  email: 'p@example.com',
  sms_consent: true,
  email_consent: true,
  ...o,
})

describe('computeFollowUpTiming — due logic', () => {
  it('is due when never contacted', () => {
    const t = computeFollowUpTiming(lead(), NOW)
    expect(t).toMatchObject({ due: true, daysSinceContact: null, reason: 'Never contacted' })
  })

  it('is due when awaiting a reply for 2+ days', () => {
    const t = computeFollowUpTiming(lead({ last_contacted_at: '2026-07-07T00:00:00Z', last_responded_at: null }), NOW)
    expect(t).toMatchObject({ due: true, awaitingReply: true, daysSinceContact: 3 })
  })

  it('is NOT due when awaiting a reply for under 2 days', () => {
    const t = computeFollowUpTiming(lead({ last_contacted_at: '2026-07-09T00:00:00Z' }), NOW)
    expect(t.due).toBe(false)
  })

  it('is due for a re-touch 3+ days after the lead last replied', () => {
    const t = computeFollowUpTiming(
      lead({ last_contacted_at: '2026-07-05T00:00:00Z', last_responded_at: '2026-07-06T00:00:00Z' }),
      NOW
    )
    expect(t).toMatchObject({ due: true, awaitingReply: false, daysSinceContact: 5 })
  })

  it('is NOT due right after the lead replied', () => {
    const t = computeFollowUpTiming(
      lead({ last_contacted_at: '2026-07-09T00:00:00Z', last_responded_at: '2026-07-09T12:00:00Z' }),
      NOW
    )
    expect(t.due).toBe(false)
  })
})

describe('computeFollowUpTiming — channel selection', () => {
  // Consent is assumed — channel choice follows which contact addresses exist.
  it('prefers SMS when a phone exists', () => {
    expect(computeFollowUpTiming(lead(), NOW).suggestedChannel).toBe('sms')
  })

  it('still prefers SMS even without a stored SMS consent flag', () => {
    expect(computeFollowUpTiming(lead({ sms_consent: false }), NOW).suggestedChannel).toBe('sms')
  })

  it('falls back to email when there is no phone', () => {
    expect(computeFollowUpTiming(lead({ phone: null }), NOW).suggestedChannel).toBe('email')
  })
})
