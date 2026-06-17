/**
 * Re-engagement ladder (Phase 3) — when a lead goes quiet, escalate the touch by
 * how long they've been silent. Mirrors the Closer agent's re-close stages
 * (src/lib/ai/closer-agent.ts) so autonomous follow-up and live agent guidance
 * stay consistent. Pure + unit-tested; the cron applies it.
 */

export type ReengagementStage =
  | 'value_add_touch' // 7–13d
  | 'testimonial_nudge' // 14–20d
  | 'deadline_anchor' // 21–29d
  | 'direct_ask' // 30–44d
  | 'final_stand' // 45–59d
  | 'graceful_release' // 60d+ (terminal — hand to a human, stop auto-touching)

export const REENGAGEMENT_MIN_IDLE_DAYS = 7

export interface ReengagementStep {
  stage: ReengagementStage
  /** Days to wait before the next ladder touch after sending this one. */
  nextDelayDays: number
  /** Terminal stage: stop the ladder and escalate to a human. */
  terminal: boolean
}

/** The stage for a given silence duration, or null if not yet due (<7d). */
export function reengagementStage(daysSinceContact: number): ReengagementStage | null {
  if (daysSinceContact >= 60) return 'graceful_release'
  if (daysSinceContact >= 45) return 'final_stand'
  if (daysSinceContact >= 30) return 'direct_ask'
  if (daysSinceContact >= 21) return 'deadline_anchor'
  if (daysSinceContact >= 14) return 'testimonial_nudge'
  if (daysSinceContact >= REENGAGEMENT_MIN_IDLE_DAYS) return 'value_add_touch'
  return null
}

const NEXT_DELAY_DAYS: Record<ReengagementStage, number> = {
  value_add_touch: 7,
  testimonial_nudge: 7,
  deadline_anchor: 9,
  direct_ask: 15,
  final_stand: 15,
  graceful_release: 0,
}

export function reengagementStep(daysSinceContact: number): ReengagementStep | null {
  const stage = reengagementStage(daysSinceContact)
  if (!stage) return null
  return {
    stage,
    nextDelayDays: NEXT_DELAY_DAYS[stage],
    terminal: stage === 'graceful_release',
  }
}

/**
 * Templated stage-appropriate SMS copy. Deterministic v1 (safe + verifiable).
 * This is the seam where the Closer LLM can later generate personalized,
 * "creative" copy per lead — swap buildReengagementMessage for an agent call.
 */
export function buildReengagementMessage(
  stage: ReengagementStage,
  p: { firstName?: string | null; orgName?: string | null }
): string {
  const name = p.firstName?.trim() || 'there'
  const org = p.orgName?.trim() || 'our team'
  switch (stage) {
    case 'value_add_touch':
      return `Hi ${name}, it's ${org}. Thought of you — here's a quick before/after from a patient with a similar case. Any questions I can answer?`
    case 'testimonial_nudge':
      return `Hi ${name}, a lot of our patients had the exact concern you mentioned. Happy to share how they worked through it — want me to send a short story?`
    case 'deadline_anchor':
      return `Hi ${name}, we're holding a consultation spot for you but the schedule is filling up for the month. Want me to lock in a time before it's gone?`
    case 'direct_ask':
      return `Hi ${name}, I want to make sure I'm being helpful and not a pest. What's holding you back right now — timing, cost, or something else? Totally honest answer is welcome.`
    case 'final_stand':
      return `Hi ${name}, last note from me for now — we have one of our best financing options open this month if you'd like me to walk you through it. Just say the word.`
    case 'graceful_release':
      return `Hi ${name}, I'll stop reaching out so I'm not crowding your inbox. The door's always open at ${org} whenever you're ready — just reply anytime.`
  }
}
