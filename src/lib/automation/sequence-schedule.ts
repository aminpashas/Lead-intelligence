/**
 * Pure scheduling logic for DB-defined outreach sequences.
 *
 * No I/O here — the cron routes and `sequences.ts` drive execution off these
 * helpers. Two anchors exist:
 *   - 'enrollment':       offsets count forward from follow_up_enrollments.enrolled_at
 *   - 'appointment_time': offsets count relative to appointments.scheduled_at
 *                         (negative = before the appointment)
 */

import type {
  OutreachSequenceStep,
  SequenceStepCondition,
} from '@/types/database'
import { DEFAULT_FOLLOWUP_SEQUENCE } from '@/lib/followup/sequence'

const MINUTE = 60 * 1000

/** The subset of a step the schedulers/executors need (full rows satisfy it). */
export type SchedulableStep = Pick<
  OutreachSequenceStep,
  | 'id'
  | 'position'
  | 'offset_minutes'
  | 'channel'
  | 'owner'
  | 'condition'
  | 'intent'
  | 'template_subject'
  | 'template_body'
  | 'enabled'
  | 'kind'
  | 'metadata'
>

export type EnrollmentState = {
  current_step: number
  enrolled_at: string
  status: 'active' | 'completed' | 'stopped'
}

/**
 * Steps the cron actually fires: enabled, ordered by position, minus
 * 'speed_to_lead' display steps (those execute on the lead-creation path).
 * Enrollment.current_step indexes into THIS list.
 */
export function executableSteps<T extends Pick<SchedulableStep, 'enabled' | 'kind' | 'position'>>(
  steps: T[]
): T[] {
  return steps
    .filter((s) => s.enabled && s.kind !== 'speed_to_lead')
    .sort((a, b) => a.position - b.position)
}

/** Absolute time (ms) an enrollment-anchored step becomes due. */
export function enrollmentStepDueAt(enrolledAtIso: string, step: Pick<SchedulableStep, 'offset_minutes'>): number {
  return new Date(enrolledAtIso).getTime() + step.offset_minutes * MINUTE
}

/**
 * Next due step for an enrollment against an executable-step list, or null
 * (not active, exhausted, or the next step's time hasn't arrived).
 */
export function nextDueEnrollmentStep<T extends SchedulableStep>(
  steps: T[],
  enrollment: EnrollmentState,
  nowMs: number
): { index: number; step: T } | null {
  if (enrollment.status !== 'active') return null
  const list = executableSteps(steps)
  const i = enrollment.current_step
  if (i >= list.length) return null
  const step = list[i]
  return enrollmentStepDueAt(enrollment.enrolled_at, step) <= nowMs ? { index: i, step } : null
}

export function isEnrollmentComplete<T extends SchedulableStep>(
  steps: T[],
  enrollment: Pick<EnrollmentState, 'current_step'>
): boolean {
  return enrollment.current_step >= executableSteps(steps).length
}

/** Does a step's condition apply given the appointment's confirmation state? */
export function conditionMatches(condition: SequenceStepCondition, confirmed: boolean): boolean {
  if (condition === 'always') return true
  return condition === 'confirmed' ? confirmed : !confirmed
}

/**
 * Appointment-anchored steps due right now. A step is due when its absolute
 * time (scheduled_at + offset) has passed but by no more than `catchUpMs`
 * (default 6h) — so a briefly-down cron catches up, but stale steps never
 * fire days late. Steps never fire once the appointment itself has passed.
 */
export function dueAppointmentSteps<T extends SchedulableStep>(
  steps: T[],
  scheduledAtIso: string,
  opts: { nowMs: number; confirmed: boolean; catchUpMs?: number }
): T[] {
  const scheduledMs = new Date(scheduledAtIso).getTime()
  if (Number.isNaN(scheduledMs) || scheduledMs <= opts.nowMs) return []
  const catchUp = opts.catchUpMs ?? 6 * 60 * MINUTE
  return executableSteps(steps).filter((step) => {
    if (!conditionMatches(step.condition, opts.confirmed)) return false
    const dueAt = scheduledMs + step.offset_minutes * MINUTE
    return dueAt <= opts.nowMs && dueAt >= opts.nowMs - catchUp
  })
}

/**
 * Dedupe key for a fired step, scoped to what it fired against
 * (enrollment id or appointment id). Used for human_tasks.dedupe_key and
 * appointment_reminders.reminder_type.
 */
export function stepDedupeKey(scopeId: string, stepId: string): string {
  return `seq:${scopeId}:${stepId}`
}

/**
 * Fallback executable steps when an org has no DB-defined new_lead_follow_up
 * sequence — mirrors the legacy hardcoded cadence so the cron never breaks.
 */
export const FALLBACK_FOLLOWUP_STEPS: SchedulableStep[] = DEFAULT_FOLLOWUP_SEQUENCE.map(
  (s, i) => ({
    id: `fallback-${i}`,
    position: i,
    offset_minutes: s.day * 24 * 60,
    channel: s.channel,
    owner: 'ai' as const,
    condition: 'always' as const,
    intent: null,
    template_subject: null,
    template_body: null,
    enabled: true,
    kind: 'step' as const,
    metadata: {},
  })
)
