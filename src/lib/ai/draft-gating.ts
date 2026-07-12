/**
 * Draft Gating — should we even produce a sales draft right now?
 *
 * The manual "AI Agent Draft" button (and the closer/setter behind it) will
 * happily compose an upbeat closing message for ANY conversation, regardless of
 * whether the lead is furious or the thread already ended. That produces the
 * classic tone-deaf draft: a cheerful "I'll send that right over!" underneath a
 * Lead Intelligence panel that says a human must step in.
 *
 * This module is the pre-generation gate. Given the same signals the analysis
 * panel is built from (patient psychology + latest engagement assessment) plus
 * the raw thread, it decides whether drafting is appropriate at all:
 *
 *   - ESCALATION: the lead is in distress / trust has collapsed → a human,
 *     not an AI, should reach out. Suppress the draft; hand the reason +
 *     recovery guidance to staff.
 *   - CLOSED: the thread already reached a natural close (we sent the last
 *     message, the patient signed off) → there is nothing to reply to, so an
 *     unprompted new message reads as spam.
 *
 * Deliberately conservative: it only blocks on clear signals so ordinary
 * drafting is untouched. It reads state only — no I/O, no side effects — so it
 * is trivially testable and safe to call from the request path.
 */

import type { ConversationMessage } from './agent-types'
import type { LeadEngagementAssessment } from './sales-techniques'
import type { PatientProfile } from '@/types/database'

export type DraftGateKind = 'escalation' | 'closed'

export type DraftGate = {
  /** True when a sales draft should NOT be auto-generated. */
  block: boolean
  kind: DraftGateKind | null
  /** Staff-facing one-liner explaining why drafting was suppressed. */
  reason: string
  /** What the human should do next, drawn from the analysis when available. */
  guidance: string | null
}

const OK: DraftGate = { block: false, kind: null, reason: '', guidance: null }

/**
 * Emotional states that mean "a human should handle this, not a closing bot."
 * Matched as case-insensitive substrings against the free-text emotional_state
 * the analyzer / agents emit (e.g. "rage and humiliation", "deeply frustrated").
 */
const DISTRESS_STATES = [
  'angry',
  'anger',
  'furious',
  'fury',
  'rage',
  'enraged',
  'frustrat',
  'humiliat',
  'betray',
  'insult',
  'hostile',
  'distrust',
  'mistrust',
  'disgust',
  'contempt',
  'offend',
  'upset',
  'fed up',
  'done', // "he is done being gaslit"
]

const NEGATIVE_TRUST = ['low', 'none', 'broken', 'lost', 'very low']

function isDistress(emotionalState: string | null | undefined): boolean {
  if (!emotionalState) return false
  const s = emotionalState.toLowerCase()
  return DISTRESS_STATES.some((d) => s.includes(d))
}

/**
 * Terminal acknowledgements — the patient signing off, not asking anything.
 * Anchored so "no thanks" matches but "no thanks, but what about financing?"
 * (which contains a real question) does not.
 */
const TERMINAL_ACK = /^(no[.,!\s]*(thanks|thank you)?|nope|nah|all set|we'?re good|i'?m good|that'?s all|that'?s it|nothing else|thanks|thank you|ty|👍|👌|ok|okay|k|sounds good|great|perfect|got it)[.!\s]*$/i

function isTerminalAck(text: string | null | undefined): boolean {
  if (!text) return false
  const t = text.trim()
  if (!t) return false
  // A question mark means they still want something — never terminal.
  if (t.includes('?')) return false
  return TERMINAL_ACK.test(t)
}

export type DraftGateInput = {
  patientProfile: Pick<PatientProfile, 'emotional_state' | 'trust_level' | 'next_best_action' | 'ai_summary'> | null
  previousAssessment: LeadEngagementAssessment | null
  history: ConversationMessage[]
  /** True when the lead has a booked/confirmed appointment (reinforces "closed"). */
  hasBookedAppointment?: boolean
}

/**
 * Decide whether to suppress the auto-draft. Escalation takes precedence over
 * "closed" — an angry lead on a technically-closed thread still needs a human.
 */
export function assessDraftGate(input: DraftGateInput): DraftGate {
  const { patientProfile, previousAssessment, history, hasBookedAppointment } = input

  // ── Escalation ──────────────────────────────────────────────────
  const profileDistress = isDistress(patientProfile?.emotional_state)
  const assessmentDistress = isDistress(previousAssessment?.emotional_state)
  const trustCollapsed =
    !!patientProfile?.trust_level && NEGATIVE_TRUST.includes(patientProfile.trust_level.toLowerCase())

  // High resistance + cold engagement is the numeric fingerprint of a lead
  // who has checked out, even when the free-text state is bland.
  const resistance = previousAssessment?.resistance_level ?? 0
  const engagement = previousAssessment?.engagement_temperature ?? 5
  const numericCheckout = resistance >= 8 && engagement <= 3

  const escalate =
    profileDistress ||
    assessmentDistress ||
    (trustCollapsed && (profileDistress || assessmentDistress || engagement <= 3)) ||
    numericCheckout

  if (escalate) {
    const feeling = patientProfile?.emotional_state || previousAssessment?.emotional_state || 'distress/disengagement'
    const guidance =
      patientProfile?.next_best_action ||
      previousAssessment?.recommended_approach ||
      patientProfile?.ai_summary ||
      null
    return {
      block: true,
      kind: 'escalation',
      reason: `This lead is showing ${feeling}. A human should reach out personally — an automated closing message risks ending the relationship.`,
      guidance,
    }
  }

  // ── Closed thread ───────────────────────────────────────────────
  // If the last thing in the thread is OUR message, the ball is in the
  // patient's court — there is nothing for us to reply to. Combined with a
  // terminal sign-off (or a booked appointment), the conversation is closed and
  // an unprompted new draft is just noise.
  const lastTurn = history.length ? history[history.length - 1] : null
  const lastInbound = [...history].reverse().find((m) => m.role === 'user') ?? null
  const weSpokeLast = lastTurn?.role === 'assistant'
  const patientSignedOff = isTerminalAck(lastInbound?.content)

  if (weSpokeLast && (patientSignedOff || hasBookedAppointment)) {
    return {
      block: true,
      kind: 'closed',
      reason: hasBookedAppointment
        ? 'This conversation already reached a natural close — the appointment is booked and we sent the last message. Draft a new message only if you have a specific reason.'
        : 'This conversation already wrapped up — the patient signed off and we sent the last message. There is nothing here to reply to.',
      guidance: null,
    }
  }

  return OK
}
