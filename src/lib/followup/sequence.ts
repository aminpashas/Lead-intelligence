/**
 * Multi-step follow-up sequence model (the "true sequence" scheduler core).
 *
 * Pure: given an enrollment's state + `nowMs`, decide which step (if any) is due.
 * The cron route (`/api/cron/follow-up-sequences`) drives sends off this; the
 * send itself is allowlist- + consent-gated elsewhere.
 */

export type SequenceStep = { day: number; channel: 'email' | 'sms' }

/** Default cadence: Day 0 email → Day 2 email nudge → Day 4 SMS (if reachable). */
export const DEFAULT_FOLLOWUP_SEQUENCE: SequenceStep[] = [
  { day: 0, channel: 'email' },
  { day: 2, channel: 'email' },
  { day: 4, channel: 'sms' },
]

export type Enrollment = {
  current_step: number
  enrolled_at: string
  status: 'active' | 'completed' | 'stopped'
}

const DAY = 24 * 60 * 60 * 1000

/** Absolute time (ms) at which a step becomes due, relative to enrollment. */
export function stepDueAt(enrolledAtIso: string, step: SequenceStep): number {
  return new Date(enrolledAtIso).getTime() + step.day * DAY
}

export function isComplete(
  enrollment: Pick<Enrollment, 'current_step'>,
  seq: SequenceStep[] = DEFAULT_FOLLOWUP_SEQUENCE
): boolean {
  return enrollment.current_step >= seq.length
}

/**
 * The next step to fire for an enrollment, or null if none is due (not active,
 * already complete, or the next step's time hasn't arrived).
 */
export function nextDueStep(
  enrollment: Enrollment,
  nowMs: number,
  seq: SequenceStep[] = DEFAULT_FOLLOWUP_SEQUENCE
): { index: number; step: SequenceStep } | null {
  if (enrollment.status !== 'active') return null
  const i = enrollment.current_step
  if (i >= seq.length) return null
  const step = seq[i]
  return stepDueAt(enrollment.enrolled_at, step) <= nowMs ? { index: i, step } : null
}
