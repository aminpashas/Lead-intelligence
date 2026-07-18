import { describe, it, expect } from 'vitest'
import { shouldAdvanceToConsult } from '@/lib/pipeline/booking-stage'

// Convenience builder so each test states only the fields it cares about.
function guard(over: Partial<Parameters<typeof shouldAdvanceToConsult>[0]>) {
  return shouldAdvanceToConsult({ currentSlug: null, isWon: false, isLost: false, ...over })
}

describe('shouldAdvanceToConsult', () => {
  describe('advances early-funnel + operational leads to Consultation Scheduled', () => {
    for (const slug of ['new', 'contacted', 'engaged', 'qualified', 'nurturing', 'no-communication', 'dnd-sms']) {
      it(`advances from ${slug}`, () => {
        expect(guard({ currentSlug: slug })).toBe(true)
      })
    }
    it('advances a lead with no stage yet (freshly ingested)', () => {
      expect(guard({ currentSlug: null })).toBe(true)
    })
  })

  describe('never pulls a further-along lead backward', () => {
    for (const slug of [
      'consultation-scheduled',
      'consultation-completed',
      'treatment-presented',
      'financing',
      'contract-signed',
      'scheduled',
      'completed',
      'lost',
    ]) {
      it(`is a no-op from ${slug}`, () => {
        expect(guard({ currentSlug: slug })).toBe(false)
      })
    }
  })

  describe('respects won/lost flags regardless of slug', () => {
    it('does not move a won lead', () => {
      expect(guard({ currentSlug: 'contacted', isWon: true })).toBe(false)
    })
    it('does not move a lost lead', () => {
      expect(guard({ currentSlug: 'contacted', isLost: true })).toBe(false)
    })
  })

  describe('leaves off-funnel parking stages for a human to reclassify', () => {
    it('does not move an existing-patient record', () => {
      expect(guard({ currentSlug: 'existing-patient' })).toBe(false)
    })
    it('does not move a junk record', () => {
      expect(guard({ currentSlug: 'junk' })).toBe(false)
    })
  })
})
