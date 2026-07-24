import { describe, it, expect } from 'vitest'
import {
  shouldSuppressBookedLead,
  campaignOptsIntoBookedStages,
  isAtOrPastConsultStage,
} from '../prospecting-guard'
import type { SmartListCriteria } from '@/types/database'

describe('prospecting-guard', () => {
  describe('isAtOrPastConsultStage', () => {
    it('is true for booked/beyond board stages', () => {
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
        expect(isAtOrPastConsultStage(slug)).toBe(true)
      }
    })

    it('is false for prospecting-phase stages and unknowns', () => {
      for (const slug of ['new', 'no-communication', 'contacted', 'following-up', 'engaged', 'qualified', null, undefined, '']) {
        expect(isAtOrPastConsultStage(slug as string | null)).toBe(false)
      }
    })
  })

  describe('campaignOptsIntoBookedStages', () => {
    it('opts in when criteria names a booked board stage', () => {
      expect(campaignOptsIntoBookedStages({ stages: ['consultation-scheduled'] } as SmartListCriteria)).toBe(true)
    })

    it('opts in when criteria names a booked/later lead status', () => {
      expect(campaignOptsIntoBookedStages({ statuses: ['contract_signed'] } as SmartListCriteria)).toBe(true)
    })

    it('does NOT opt in for a top-of-funnel prospecting campaign', () => {
      expect(campaignOptsIntoBookedStages({ statuses: ['new'], service_line: 'implants' } as SmartListCriteria)).toBe(false)
      expect(campaignOptsIntoBookedStages({ stages: ['contacted', 'engaged'] } as SmartListCriteria)).toBe(false)
      expect(campaignOptsIntoBookedStages(null)).toBe(false)
      expect(campaignOptsIntoBookedStages({} as SmartListCriteria)).toBe(false)
    })
  })

  describe('shouldSuppressBookedLead', () => {
    const prospecting = { statuses: ['new'], service_line: 'implants' } as SmartListCriteria

    it('suppresses a booked lead from a prospecting campaign (the Vitali case)', () => {
      // Lead status frozen at "new", but board stage says booked.
      expect(shouldSuppressBookedLead({ stageSlug: 'consultation-scheduled', criteria: prospecting })).toBe(true)
    })

    it('suppresses a contract-signed lead from a prospecting campaign', () => {
      expect(shouldSuppressBookedLead({ stageSlug: 'contract-signed', criteria: prospecting })).toBe(true)
    })

    it('does NOT suppress a genuinely-new lead', () => {
      expect(shouldSuppressBookedLead({ stageSlug: 'new', criteria: prospecting })).toBe(false)
      expect(shouldSuppressBookedLead({ stageSlug: 'contacted', criteria: prospecting })).toBe(false)
    })

    it('does NOT suppress when the campaign opts into booked leads', () => {
      const nurture = { stages: ['consultation-completed'] } as SmartListCriteria
      expect(shouldSuppressBookedLead({ stageSlug: 'consultation-completed', criteria: nurture })).toBe(false)
    })
  })
})
