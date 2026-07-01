type AttendanceCandidate = {
  status: string
  scheduled_at: string
  duration_minutes: number | null
  outcome_prompt_sent_at: string | null
}

/** An appointment whose time has passed but has no terminal decision yet. */
export function shouldPromptOutcome(appt: AttendanceCandidate, now: Date): boolean {
  if (appt.status !== 'scheduled' && appt.status !== 'confirmed') return false
  if (appt.outcome_prompt_sent_at) return false
  const end = new Date(appt.scheduled_at).getTime() + (appt.duration_minutes ?? 60) * 60_000
  return end < now.getTime()
}

type FeedbackCandidate = { status: string; outcome_recorded_at: string | null }

/** A showed + outcome-recorded appointment past its feedback delay window. */
export function isFeedbackDue(appt: FeedbackCandidate, now: Date, delayHours: number): boolean {
  if (appt.status !== 'completed' || !appt.outcome_recorded_at) return false
  const due = new Date(appt.outcome_recorded_at).getTime() + delayHours * 3_600_000
  return now.getTime() >= due
}
