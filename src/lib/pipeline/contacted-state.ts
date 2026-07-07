/**
 * Pure classification of a lead sitting in the "Following Up" funnel plus the
 * Day-N cadence timeline shown on its card. No I/O — the SQL backfill, the
 * encounter processor, and the card badge all reason off these functions so the
 * board and the database never disagree.
 *
 * The thresholds here are mirrored verbatim by the SQL backfill in
 * supabase/migrations/20260707120000_following_up_engaged_stages.sql. If you
 * change ENGAGED_MAX_CADENCE_DAYS, change the SQL interval too.
 */

import { DEFAULT_FOLLOWUP_SEQUENCE, stepDueAt } from '@/lib/followup/sequence'

/** A lead is out of active cadence after this many days of silence. */
export const ENGAGED_MAX_CADENCE_DAYS = 14

const DAY = 24 * 60 * 60 * 1000

export type ContactedState = 'following-up' | 'engaged' | 'nurturing'

export type ContactSignals = {
  last_contacted_at: string | null
  last_responded_at: string | null
  total_messages_received: number | null
}

/** Has the lead replied to us at all? */
export function hasReplied(s: ContactSignals): boolean {
  if ((s.total_messages_received ?? 0) > 0) return true
  if (!s.last_responded_at) return false
  if (!s.last_contacted_at) return true
  return Date.parse(s.last_responded_at) >= Date.parse(s.last_contacted_at)
}

/** Classify a Following-Up lead into its true sub-state. */
export function classifyContactedState(s: ContactSignals, nowMs: number): ContactedState {
  if (hasReplied(s)) return 'engaged'
  if (s.last_contacted_at && Date.parse(s.last_contacted_at) < nowMs - ENGAGED_MAX_CADENCE_DAYS * DAY) {
    return 'nurturing'
  }
  return 'following-up'
}

export type TimelineEnrollment = {
  status: 'active' | 'completed' | 'stopped'
  current_step: number
  enrolled_at: string
}

export type CadenceTimeline = {
  /** Whole days since enrollment (the "Day N" label). */
  dayN: number
  /** 0-based index of the next step to fire. */
  stepIndex: number
  totalSteps: number
  /** Absolute ms of the next scheduled touch, or null if none remain. */
  nextTouchAtMs: number | null
  /** Cadence finished (completed/stopped or past the last step) with no reply. */
  exhausted: boolean
}

/** The Day-N badge model for a card, or null when there is no enrollment. */
export function cadenceTimeline(args: {
  enrollment: TimelineEnrollment | null
  now: number
}): CadenceTimeline | null {
  const { enrollment, now } = args
  if (!enrollment) return null
  const total = DEFAULT_FOLLOWUP_SEQUENCE.length
  const dayN = Math.max(0, Math.floor((now - Date.parse(enrollment.enrolled_at)) / DAY))
  const stepIndex = Math.min(enrollment.current_step, total)
  const exhausted = enrollment.status !== 'active' || stepIndex >= total
  const nextTouchAtMs = exhausted
    ? null
    : stepDueAt(enrollment.enrolled_at, DEFAULT_FOLLOWUP_SEQUENCE[stepIndex])
  return { dayN, stepIndex, totalSteps: total, nextTouchAtMs, exhausted }
}
