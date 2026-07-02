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
    expect(nextDueStep(enrollment(), t('2026-07-01T00:00:00Z'))).toMatchObject({ index: 0, step: { day: 0, channel: 'email' } })
  })

  it('step 1 (day 2) is not due at day 1 but is due at day 2', () => {
    expect(nextDueStep(enrollment({ current_step: 1 }), t('2026-07-02T00:00:00Z'))).toBeNull()
    expect(nextDueStep(enrollment({ current_step: 1 }), t('2026-07-03T00:00:00Z'))).toMatchObject({ index: 1 })
  })

  it('the day-4 SMS is the final step', () => {
    expect(nextDueStep(enrollment({ current_step: 2 }), t('2026-07-05T00:00:00Z'))).toMatchObject({ index: 2, step: { channel: 'sms' } })
  })

  it('returns null once every step is complete', () => {
    const done = enrollment({ current_step: 3 })
    expect(isComplete(done)).toBe(true)
    expect(nextDueStep(done, t('2026-08-01T00:00:00Z'))).toBeNull()
  })

  it('never fires for a stopped enrollment (e.g. lead replied)', () => {
    expect(nextDueStep(enrollment({ status: 'stopped' }), t('2026-09-01T00:00:00Z'))).toBeNull()
  })

  it('stepDueAt offsets from enrollment by the step day', () => {
    expect(stepDueAt(ENROLLED, DEFAULT_FOLLOWUP_SEQUENCE[1])).toBe(t('2026-07-03T00:00:00Z'))
  })
})
