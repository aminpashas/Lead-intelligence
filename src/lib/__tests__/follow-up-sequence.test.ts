import { describe, it, expect } from 'vitest'
import { nextDueStep, stepDueAt, isComplete, DEFAULT_FOLLOWUP_SEQUENCE, type Enrollment } from '@/lib/followup/sequence'

const ENROLLED = '2026-07-01T00:00:00Z'
const t = (iso: string) => new Date(iso).getTime()

const enrollment = (o: Partial<Enrollment> = {}): Enrollment => ({
  current_step: 0,
  enrolled_at: ENROLLED,
  status: 'active',
  ...o,
})

describe('follow-up sequence', () => {
  it('step 0 (day 0) is due immediately on enrollment', () => {
    expect(nextDueStep(enrollment(), t('2026-07-01T00:00:00Z'))).toMatchObject({ index: 0, step: { day: 0, channel: 'sms' } })
  })

  it('step 1 (day 1) is not due at day 0 but is due at day 1', () => {
    expect(nextDueStep(enrollment({ current_step: 1 }), t('2026-07-01T00:00:00Z'))).toBeNull()
    expect(nextDueStep(enrollment({ current_step: 1 }), t('2026-07-02T00:00:00Z'))).toMatchObject({ index: 1 })
  })

  it('the day-2 SMS fires at its scheduled day', () => {
    expect(nextDueStep(enrollment({ current_step: 2 }), t('2026-07-03T00:00:00Z'))).toMatchObject({ index: 2, step: { channel: 'sms' } })
  })

  it('returns null once every step is complete', () => {
    const done = enrollment({ current_step: 8 })
    expect(isComplete(done)).toBe(true)
    expect(nextDueStep(done, t('2026-08-01T00:00:00Z'))).toBeNull()
  })

  it('never fires for a stopped enrollment (e.g. lead replied)', () => {
    expect(nextDueStep(enrollment({ status: 'stopped' }), t('2026-09-01T00:00:00Z'))).toBeNull()
  })

  it('stepDueAt offsets from enrollment by the step day', () => {
    expect(stepDueAt(ENROLLED, DEFAULT_FOLLOWUP_SEQUENCE[1])).toBe(t('2026-07-02T00:00:00Z'))
  })
})

describe('DEFAULT_FOLLOWUP_SEQUENCE', () => {
  it('is a front-loaded 8-touch schedule over ~14 days', () => {
    expect(DEFAULT_FOLLOWUP_SEQUENCE.map((s) => s.day)).toEqual([0, 1, 2, 4, 7, 10, 14, 14])
    expect(DEFAULT_FOLLOWUP_SEQUENCE).toHaveLength(8)
    expect(DEFAULT_FOLLOWUP_SEQUENCE.filter((s) => s.day <= 2)).toHaveLength(3)
  })

  it('is complete only after the 8th step', () => {
    expect(isComplete({ current_step: 7 })).toBe(false)
    expect(isComplete({ current_step: 8 })).toBe(true)
  })

  it('both Day-14 steps (indices 6 & 7) become due together at enrolled + 14d', () => {
    const DAY14 = t('2026-07-15T00:00:00Z') // ENROLLED (2026-07-01) + 14 days
    const JUST_BEFORE_DAY14 = t('2026-07-14T23:59:59Z')

    // Index 6 (Day-14 email): still pending just before day 14, due exactly at day 14.
    expect(nextDueStep(enrollment({ current_step: 6 }), JUST_BEFORE_DAY14)).toBeNull()
    expect(nextDueStep(enrollment({ current_step: 6 }), DAY14)).toMatchObject({ index: 6, step: { day: 14, channel: 'email' } })

    // Index 7 (Day-14 SMS breakup): due at the same moment as index 6.
    expect(nextDueStep(enrollment({ current_step: 7 }), DAY14)).toMatchObject({ index: 7, step: { day: 14, channel: 'sms' } })

    // Both resolve to the identical due timestamp.
    expect(stepDueAt(ENROLLED, DEFAULT_FOLLOWUP_SEQUENCE[6])).toBe(DAY14)
    expect(stepDueAt(ENROLLED, DEFAULT_FOLLOWUP_SEQUENCE[7])).toBe(DAY14)
  })
})
