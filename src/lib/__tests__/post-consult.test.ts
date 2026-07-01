import { describe, it, expect } from 'vitest'
import { shouldPromptOutcome, isFeedbackDue } from '@/lib/appointments/post-consult'

const NOW = new Date('2026-07-01T18:00:00Z')

describe('shouldPromptOutcome', () => {
  const base = { status: 'confirmed', duration_minutes: 60, outcome_prompt_sent_at: null }
  it('true when the appointment has ended and is undecided/unprompted', () => {
    expect(shouldPromptOutcome({ ...base, scheduled_at: '2026-07-01T16:00:00Z' }, NOW)).toBe(true)
  })
  it('false when the appointment has not yet ended', () => {
    expect(shouldPromptOutcome({ ...base, scheduled_at: '2026-07-01T17:30:00Z' }, NOW)).toBe(false)
  })
  it('false when already prompted', () => {
    expect(shouldPromptOutcome({ ...base, scheduled_at: '2026-07-01T16:00:00Z', outcome_prompt_sent_at: '2026-07-01T17:05:00Z' }, NOW)).toBe(false)
  })
  it('false for terminal statuses', () => {
    expect(shouldPromptOutcome({ ...base, status: 'completed', scheduled_at: '2026-07-01T16:00:00Z' }, NOW)).toBe(false)
    expect(shouldPromptOutcome({ ...base, status: 'no_show', scheduled_at: '2026-07-01T16:00:00Z' }, NOW)).toBe(false)
  })
})

describe('isFeedbackDue', () => {
  it('true when completed + outcome recorded + past the delay window', () => {
    expect(isFeedbackDue({ status: 'completed', outcome_recorded_at: '2026-07-01T15:00:00Z' }, NOW, 2)).toBe(true)
  })
  it('false before the delay window elapses', () => {
    expect(isFeedbackDue({ status: 'completed', outcome_recorded_at: '2026-07-01T17:00:00Z' }, NOW, 2)).toBe(false)
  })
  it('false when no outcome was recorded', () => {
    expect(isFeedbackDue({ status: 'completed', outcome_recorded_at: null }, NOW, 2)).toBe(false)
  })
})
