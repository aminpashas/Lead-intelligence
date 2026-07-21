import { describe, it, expect } from 'vitest'
import { nextStageForEncounter, type EncounterStageInput } from '@/lib/pipeline/encounter-stage'

// Convenience builder so each test states only the fields it cares about.
function input(over: Partial<EncounterStageInput>): EncounterStageInput {
  return {
    channel: 'sms',
    inbound: false,
    appointmentBooked: false,
    durationSeconds: null,
    currentStageSlug: null,
    ...over,
  }
}

describe('nextStageForEncounter', () => {
  describe('appointment booked → qualified', () => {
    it('advances from new', () => {
      expect(nextStageForEncounter(input({ appointmentBooked: true, currentStageSlug: 'new' }))).toBe('qualified')
    })
    it('advances from contacted', () => {
      expect(nextStageForEncounter(input({ appointmentBooked: true, currentStageSlug: 'contacted' }))).toBe('qualified')
    })
    it('advances from engaged', () => {
      expect(nextStageForEncounter(input({ appointmentBooked: true, currentStageSlug: 'engaged' }))).toBe('qualified')
    })
    it('is a no-op when already beyond the funnel (consultation-scheduled)', () => {
      expect(
        nextStageForEncounter(input({ appointmentBooked: true, currentStageSlug: 'consultation-scheduled' }))
      ).toBeNull()
    })
    it('is a no-op when already qualified', () => {
      expect(nextStageForEncounter(input({ appointmentBooked: true, currentStageSlug: 'qualified' }))).toBeNull()
    })
  })

  describe('inbound reply on text/email → engaged', () => {
    it('advances a contacted lead', () => {
      expect(
        nextStageForEncounter(input({ channel: 'sms', inbound: true, currentStageSlug: 'contacted' }))
      ).toBe('engaged')
    })
    it('advances a new lead', () => {
      expect(
        nextStageForEncounter(input({ channel: 'sms', inbound: true, currentStageSlug: 'new' }))
      ).toBe('engaged')
    })
    it('is a no-op on an already-engaged lead', () => {
      expect(
        nextStageForEncounter(input({ channel: 'sms', inbound: true, currentStageSlug: 'engaged' }))
      ).toBeNull()
    })
    it('works for email channel too', () => {
      expect(
        nextStageForEncounter(input({ channel: 'email', inbound: true, currentStageSlug: 'new' }))
      ).toBe('engaged')
    })
  })

  describe('voice outreach → contacted', () => {
    it('advances a new lead on a >60s call', () => {
      expect(
        nextStageForEncounter(input({ channel: 'voice', durationSeconds: 120, currentStageSlug: 'new' }))
      ).toBe('contacted')
    })
    it('never moves an engaged lead backward on a >60s call', () => {
      expect(
        nextStageForEncounter(input({ channel: 'voice', durationSeconds: 120, currentStageSlug: 'engaged' }))
      ).toBeNull()
    })
    it('does nothing for a <=60s call', () => {
      expect(
        nextStageForEncounter(input({ channel: 'voice', durationSeconds: 60, currentStageSlug: 'new' }))
      ).toBeNull()
    })
    it('does nothing when duration is null', () => {
      expect(
        nextStageForEncounter(input({ channel: 'voice', durationSeconds: null, currentStageSlug: 'new' }))
      ).toBeNull()
    })
  })

  describe('outbound text/email → contacted', () => {
    it('advances a new lead', () => {
      expect(
        nextStageForEncounter(input({ channel: 'sms', inbound: false, currentStageSlug: 'new' }))
      ).toBe('contacted')
    })
    it('is a no-op on an already-contacted lead', () => {
      expect(
        nextStageForEncounter(input({ channel: 'sms', inbound: false, currentStageSlug: 'contacted' }))
      ).toBeNull()
    })
  })

  describe('null current stage is treated as rank -1 (any forward move allowed)', () => {
    it('outbound sms → contacted', () => {
      expect(
        nextStageForEncounter(input({ channel: 'sms', inbound: false, currentStageSlug: null }))
      ).toBe('contacted')
    })
    it('inbound sms → engaged', () => {
      expect(
        nextStageForEncounter(input({ channel: 'sms', inbound: true, currentStageSlug: null }))
      ).toBe('engaged')
    })
  })

  describe('no-communication (un-worked intake queue) advances like new', () => {
    it('inbound sms lifts a No Communication lead to engaged', () => {
      expect(
        nextStageForEncounter(input({ channel: 'sms', inbound: true, currentStageSlug: 'no-communication' }))
      ).toBe('engaged')
    })
    it('inbound email lifts a No Communication lead to engaged', () => {
      expect(
        nextStageForEncounter(input({ channel: 'email', inbound: true, currentStageSlug: 'no-communication' }))
      ).toBe('engaged')
    })
    it('outbound sms lifts a No Communication lead to contacted', () => {
      expect(
        nextStageForEncounter(input({ channel: 'sms', inbound: false, currentStageSlug: 'no-communication' }))
      ).toBe('contacted')
    })
    it('a >60s call lifts a No Communication lead to contacted', () => {
      expect(
        nextStageForEncounter(input({ channel: 'voice', durationSeconds: 120, currentStageSlug: 'no-communication' }))
      ).toBe('contacted')
    })
    it('leaves the suppression queue (dnd-sms) alone on a reply', () => {
      expect(
        nextStageForEncounter(input({ channel: 'sms', inbound: true, currentStageSlug: 'dnd-sms' }))
      ).toBeNull()
    })
    it('leaves nurturing alone on a reply (own re-engagement flow)', () => {
      expect(
        nextStageForEncounter(input({ channel: 'sms', inbound: true, currentStageSlug: 'nurturing' }))
      ).toBeNull()
    })
  })

  describe('unknown/advanced current stage → no early-funnel move', () => {
    it('would-be contacted move is suppressed when already qualified', () => {
      expect(
        nextStageForEncounter(input({ channel: 'sms', inbound: false, currentStageSlug: 'qualified' }))
      ).toBeNull()
    })
    it('would-be engaged move is suppressed when already consultation-scheduled', () => {
      expect(
        nextStageForEncounter(input({ channel: 'sms', inbound: true, currentStageSlug: 'consultation-scheduled' }))
      ).toBeNull()
    })
  })
})
