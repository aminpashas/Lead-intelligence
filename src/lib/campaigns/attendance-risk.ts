/**
 * No-show risk math — pure and unit-tested.
 *
 * The core policy change vs. the old scorer: confirmation is a strong DOWNWARD
 * signal (base 5 instead of 30), not a terminal state. Prior no-shows, dead
 * reminders, and an ignored morning-of check-in still count, so a serial
 * no-shower who texts "C" no longer reads as zero-risk.
 */

export type NoShowRiskInput = {
  confirmed: boolean
  priorNoShows: number
  engagementScore: number | null
  remindersSent: number
  remindersFailed: number
  remindersUnanswered: number
  /** Tier-1 check-in went out and the 2h reply window elapsed with silence. */
  checkinExpiredUnanswered: boolean
}

/** Escalation thresholds — future per-practice tuning goes into booking_settings. */
export const RISK_TIER1 = 40
export const RISK_TIER2 = 70
export const CHECKIN_REPLY_WINDOW_MS = 2 * 60 * 60 * 1000

export function computeNoShowRisk(input: NoShowRiskInput): number {
  let risk = input.confirmed ? 5 : 30
  risk += Math.min(input.priorNoShows * 20, 40)
  if (input.engagementScore !== null && input.engagementScore < 20) risk += 10
  if (input.remindersFailed > 0) risk += 15
  if (input.remindersSent > 0 && input.remindersUnanswered === input.remindersSent) risk += 20
  if (input.checkinExpiredUnanswered) risk += 25
  return Math.min(risk, 100)
}

export function selectEscalationTier(risk: number): 0 | 1 | 2 {
  if (risk >= RISK_TIER2) return 2
  if (risk >= RISK_TIER1) return 1
  return 0
}

export function isCheckinExpired(
  checkinSentAt: string | null,
  checkinRepliedAt: string | null,
  now: Date
): boolean {
  if (!checkinSentAt || checkinRepliedAt) return false
  return now.getTime() - new Date(checkinSentAt).getTime() >= CHECKIN_REPLY_WINDOW_MS
}
