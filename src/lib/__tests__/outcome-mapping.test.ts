import { describe, it, expect } from 'vitest'
import { outcomeToLeadStatus } from '@/lib/appointments/outcome'

describe('outcomeToLeadStatus', () => {
  it('maps acceptance to treatment_presented', () => {
    expect(outcomeToLeadStatus('treatment_accepted')).toBe('treatment_presented')
  })
  it('maps deposit_paid to financing', () => {
    expect(outcomeToLeadStatus('deposit_paid')).toBe('financing')
  })
  it('maps considering and no_decision to consultation_completed', () => {
    expect(outcomeToLeadStatus('considering')).toBe('consultation_completed')
    expect(outcomeToLeadStatus('no_decision')).toBe('consultation_completed')
  })
  it('maps declined to lost and referred_out to disqualified', () => {
    expect(outcomeToLeadStatus('declined')).toBe('lost')
    expect(outcomeToLeadStatus('referred_out')).toBe('disqualified')
  })
})
