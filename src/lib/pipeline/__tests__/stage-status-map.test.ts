import { describe, it, expect } from 'vitest'
import { advancedStatusForStage, stageSlugToStatus } from '../stage-status-map'

describe('stage-status-map', () => {
  describe('stageSlugToStatus', () => {
    it('maps funnel stages to their implied status', () => {
      expect(stageSlugToStatus('consultation-scheduled')).toBe('consultation_scheduled')
      expect(stageSlugToStatus('contract-signed')).toBe('contract_signed')
      expect(stageSlugToStatus('contacted')).toBe('contacted')
      expect(stageSlugToStatus('engaged')).toBe('contacted')
    })

    it('returns null for operational / off-funnel / unknown stages', () => {
      for (const slug of ['nurturing', 'dnd-sms', 'no-show', 'existing-patient', 'junk', 'whatever', null, undefined]) {
        expect(stageSlugToStatus(slug as string | null)).toBeNull()
      }
    })
  })

  describe('advancedStatusForStage', () => {
    it('advances a frozen new lead to match a booked stage (the Vitali case)', () => {
      expect(advancedStatusForStage({ currentStatus: 'new', targetSlug: 'consultation-scheduled' }))
        .toBe('consultation_scheduled')
    })

    it('advances an unknown/absent current status forward into the funnel', () => {
      expect(advancedStatusForStage({ currentStatus: null, targetSlug: 'consultation-scheduled' }))
        .toBe('consultation_scheduled')
      expect(advancedStatusForStage({ currentStatus: 'dormant', targetSlug: 'qualified' }))
        .toBe('qualified')
    })

    it('never moves backward', () => {
      expect(advancedStatusForStage({ currentStatus: 'contract_signed', targetSlug: 'consultation-scheduled' }))
        .toBeNull()
      expect(advancedStatusForStage({ currentStatus: 'consultation_scheduled', targetSlug: 'consultation-scheduled' }))
        .toBeNull() // equal rank = no move
    })

    it('never resurrects a terminal lead', () => {
      expect(advancedStatusForStage({ currentStatus: 'lost', targetSlug: 'consultation-scheduled' })).toBeNull()
      expect(advancedStatusForStage({ currentStatus: 'disqualified', targetSlug: 'contract-signed' })).toBeNull()
    })

    it('never itself sets a terminal status (operational/off-funnel target = no-op)', () => {
      expect(advancedStatusForStage({ currentStatus: 'new', targetSlug: 'nurturing' })).toBeNull()
      expect(advancedStatusForStage({ currentStatus: 'new', targetSlug: 'lost' })).toBeNull()
    })
  })
})
