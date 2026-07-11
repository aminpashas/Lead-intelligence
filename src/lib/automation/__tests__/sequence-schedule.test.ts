import { describe, it, expect } from 'vitest'
import {
  executableSteps,
  nextDueEnrollmentStep,
  isEnrollmentComplete,
  conditionMatches,
  dueAppointmentSteps,
  stepDedupeKey,
  FALLBACK_FOLLOWUP_STEPS,
  type SchedulableStep,
  type EnrollmentState,
} from '@/lib/automation/sequence-schedule'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const step = (overrides: Partial<SchedulableStep> = {}): SchedulableStep => ({
  id: overrides.id ?? `step-${overrides.position ?? 0}`,
  position: 0,
  offset_minutes: 0,
  channel: 'sms',
  owner: 'ai',
  condition: 'always',
  intent: null,
  template_subject: null,
  template_body: null,
  enabled: true,
  kind: 'step',
  metadata: {},
  ...overrides,
})

const enrollment = (overrides: Partial<EnrollmentState> = {}): EnrollmentState => ({
  current_step: 0,
  enrolled_at: new Date(0).toISOString(),
  status: 'active',
  ...overrides,
})

describe('executableSteps', () => {
  it('drops disabled and speed_to_lead steps, sorts by position', () => {
    const steps = [
      step({ position: 2 }),
      step({ position: 0, kind: 'speed_to_lead' }),
      step({ position: 1, enabled: false }),
      step({ position: 3 }),
    ]
    const result = executableSteps(steps)
    expect(result.map((s) => s.position)).toEqual([2, 3])
  })
})

describe('nextDueEnrollmentStep', () => {
  const steps = [
    step({ position: 0, kind: 'speed_to_lead' }), // skipped
    step({ position: 1, offset_minutes: 24 * 60 }), // day 1
    step({ position: 2, offset_minutes: 2 * 24 * 60 }), // day 2
  ]

  it('indexes current_step into the executable list (speed_to_lead excluded)', () => {
    const due = nextDueEnrollmentStep(steps, enrollment(), 1 * DAY + 1)
    expect(due?.step.position).toBe(1)
  })

  it('returns null before the step is due', () => {
    expect(nextDueEnrollmentStep(steps, enrollment(), 1 * DAY - 1)).toBeNull()
  })

  it('returns null when not active or exhausted', () => {
    expect(nextDueEnrollmentStep(steps, enrollment({ status: 'stopped' }), 10 * DAY)).toBeNull()
    expect(nextDueEnrollmentStep(steps, enrollment({ current_step: 2 }), 10 * DAY)).toBeNull()
  })

  it('completes when current_step reaches the executable count', () => {
    expect(isEnrollmentComplete(steps, { current_step: 2 })).toBe(true)
    expect(isEnrollmentComplete(steps, { current_step: 1 })).toBe(false)
  })
})

describe('conditionMatches', () => {
  it('maps always/confirmed/unconfirmed', () => {
    expect(conditionMatches('always', true)).toBe(true)
    expect(conditionMatches('always', false)).toBe(true)
    expect(conditionMatches('confirmed', true)).toBe(true)
    expect(conditionMatches('confirmed', false)).toBe(false)
    expect(conditionMatches('unconfirmed', false)).toBe(true)
    expect(conditionMatches('unconfirmed', true)).toBe(false)
  })
})

describe('dueAppointmentSteps', () => {
  const appt = new Date(10 * DAY).toISOString() // appointment at t=10d
  const steps = [
    step({ position: 0, offset_minutes: -72 * 60 }), // 72h before
    step({ position: 1, offset_minutes: -24 * 60, condition: 'unconfirmed' }),
    step({ position: 2, offset_minutes: -2 * 60, condition: 'confirmed' }),
  ]

  it('fires a step inside its due window', () => {
    const nowMs = 10 * DAY - 72 * HOUR + 5 * MINUTE
    const due = dueAppointmentSteps(steps, appt, { nowMs, confirmed: false })
    expect(due.map((s) => s.position)).toEqual([0])
  })

  it('respects the catch-up cap (stale steps never fire late)', () => {
    const nowMs = 10 * DAY - 72 * HOUR + 7 * HOUR // 7h past due, cap is 6h
    const due = dueAppointmentSteps(steps, appt, { nowMs, confirmed: false })
    expect(due).toEqual([])
  })

  it('filters by confirmation condition', () => {
    const nowMs = 10 * DAY - 24 * HOUR + MINUTE
    expect(
      dueAppointmentSteps(steps, appt, { nowMs, confirmed: false }).map((s) => s.position)
    ).toEqual([1])
    expect(
      dueAppointmentSteps(steps, appt, { nowMs, confirmed: true }).map((s) => s.position)
    ).toEqual([])
  })

  it('never fires once the appointment has passed', () => {
    const due = dueAppointmentSteps(steps, appt, { nowMs: 10 * DAY + MINUTE, confirmed: true })
    expect(due).toEqual([])
  })
})

describe('fallback + dedupe', () => {
  it('fallback mirrors the legacy 8-touch cadence', () => {
    expect(FALLBACK_FOLLOWUP_STEPS).toHaveLength(8)
    expect(FALLBACK_FOLLOWUP_STEPS[0]).toMatchObject({ offset_minutes: 0, channel: 'sms' })
    expect(FALLBACK_FOLLOWUP_STEPS[7]).toMatchObject({ offset_minutes: 14 * 24 * 60, channel: 'sms' })
  })

  it('dedupe key is scoped to enrollment/appointment + step', () => {
    expect(stepDedupeKey('enr-1', 'step-a')).toBe('seq:enr-1:step-a')
  })
})
