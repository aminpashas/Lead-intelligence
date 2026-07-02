import { describe, it, expect } from 'vitest'
import {
  isPreConsultStatus,
  mapEhrEventToStageEvent,
  resolveStageForEvent,
  type AppointmentStageEvent,
} from '@/lib/pipeline/stage-mover'
import type { PipelineStage } from '@/types/database'

const stage = (over: Partial<PipelineStage>): PipelineStage => ({
  id: 'x',
  organization_id: 'org-1',
  name: 'Stage',
  slug: 'stage',
  description: null,
  color: '#888888',
  position: 0,
  is_default: false,
  is_won: false,
  is_lost: false,
  auto_actions: [],
  created_at: '2026-01-01T00:00:00Z',
  ...over,
})

const STAGES: PipelineStage[] = [
  stage({ id: 's-new', name: 'New Leads', slug: 'new', position: 0 }),
  stage({ id: 's-qual', name: 'Qualified', slug: 'qualified', position: 1 }),
  stage({ id: 's-booked', name: 'Consultation Scheduled', slug: 'consultation-scheduled', position: 2 }),
  stage({ id: 's-reeng', name: 'Re-Engage / No-Show', slug: 're-engage', position: 3 }),
  stage({ id: 's-won', name: 'Won', slug: 'won', position: 4, is_won: true }),
  stage({ id: 's-lost', name: 'Lost', slug: 'lost', position: 5, is_lost: true }),
]

describe('resolveStageForEvent', () => {
  it('booked → the consult/scheduled stage', () => {
    const r = resolveStageForEvent(STAGES, 'booked', 's-new')
    expect(r).toEqual({ stage: expect.objectContaining({ id: 's-booked' }) })
  })

  it('no_show and canceled → the re-engage stage', () => {
    for (const event of ['no_show', 'canceled'] as AppointmentStageEvent[]) {
      const r = resolveStageForEvent(STAGES, event, 's-booked')
      expect(r).toEqual({ stage: expect.objectContaining({ id: 's-reeng' }) })
    }
  })

  it('never moves a lead parked in a won/lost stage', () => {
    expect(resolveStageForEvent(STAGES, 'booked', 's-won')).toEqual({ skip: 'won_lost_stage' })
    expect(resolveStageForEvent(STAGES, 'no_show', 's-lost')).toEqual({ skip: 'won_lost_stage' })
  })

  it('no-op when already in the target stage', () => {
    expect(resolveStageForEvent(STAGES, 'booked', 's-booked')).toEqual({ skip: 'already_in_stage' })
  })

  it('no-op when the org has no matching stage', () => {
    const bare = STAGES.filter((s) => s.id === 's-new' || s.id === 's-qual')
    expect(resolveStageForEvent(bare, 'booked', 's-new')).toEqual({ skip: 'no_matching_stage' })
    expect(resolveStageForEvent(bare, 'no_show', 's-new')).toEqual({ skip: 'no_matching_stage' })
  })

  it('never targets a won/lost stage even if its name matches', () => {
    const tricky = [
      stage({ id: 's-a', name: 'New', slug: 'new', position: 0 }),
      stage({ id: 's-trap', name: 'Booked & Won', slug: 'booked-won', position: 1, is_won: true }),
    ]
    expect(resolveStageForEvent(tricky, 'booked', 's-a')).toEqual({ skip: 'no_matching_stage' })
  })

  it('null current stage still resolves a target', () => {
    const r = resolveStageForEvent(STAGES, 'booked', null)
    expect(r).toEqual({ stage: expect.objectContaining({ id: 's-booked' }) })
  })
})

describe('mapEhrEventToStageEvent', () => {
  it("classifies cancels from the appointment status, not the 'Status' trigger name", () => {
    expect(mapEhrEventToStageEvent('Status', 'Cancelled')).toBe('canceled')
  })

  it('classifies no-shows from the appointment status', () => {
    expect(mapEhrEventToStageEvent('Status', 'NoShow')).toBe('no_show')
    expect(mapEhrEventToStageEvent('Status', 'No Show')).toBe('no_show')
  })

  it('falls back to the trigger name for create/reschedule', () => {
    expect(mapEhrEventToStageEvent('Scheduled', undefined)).toBe('booked')
    expect(mapEhrEventToStageEvent('Rescheduled', null)).toBe('booked')
  })

  it('a confirmed status counts as booked', () => {
    expect(mapEhrEventToStageEvent('Status', 'Confirmed')).toBe('booked')
  })

  it('returns null when neither trigger nor status classifies the event', () => {
    expect(mapEhrEventToStageEvent('Status', undefined)).toBeNull()
    expect(mapEhrEventToStageEvent('Updated', 'SomethingElse')).toBeNull()
  })
})

describe('isPreConsultStatus', () => {
  it('pre-consult statuses are true', () => {
    for (const s of ['new', 'contacted', 'qualified', 'no_show', 'unresponsive', 'dormant']) {
      expect(isPreConsultStatus(s), s).toBe(true)
    }
  })

  it("consultation_scheduled is pre-consult (the consult hasn't happened yet — scheduled → no_show is legal)", () => {
    expect(isPreConsultStatus('consultation_scheduled')).toBe(true)
  })

  it('statuses at or past a completed consult are false — webhook automation must never regress them', () => {
    for (const s of [
      'consultation_completed',
      'treatment_presented',
      'financing',
      'contract_sent',
      'contract_signed',
      'scheduled',
      'in_treatment',
      'completed',
      'lost',
      'disqualified',
    ]) {
      expect(isPreConsultStatus(s), s).toBe(false)
    }
  })
})
