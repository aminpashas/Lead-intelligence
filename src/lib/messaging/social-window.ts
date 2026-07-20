/**
 * Meta's 24-hour messaging window, evaluated client-side from the loaded thread.
 *
 * Meta only permits a Page to send free-form messages within 24 hours of the
 * contact's last INBOUND message. Past that, GHL refuses the send upstream with
 * CONVERSATIONS_MSG_CHAT_NO_LONGER_ACTIVE (see classifyGhlSendError).
 *
 * We WARN rather than block. Our copy of the thread can lag Meta's — a missed
 * webhook or a backfilled GHL history can make a live window look closed — and
 * wrongly disabling the composer costs more than a rejected send does. The
 * upstream 400 remains the source of truth; this is only a heads-up.
 *
 * Pure functions over already-loaded rows, so they unit-test without a DB.
 */
import type { ConversationChannel } from '@/lib/channels'

/** Meta's limit for free-form Page→user messages, in milliseconds. */
export const SOCIAL_WINDOW_MS = 24 * 60 * 60 * 1000

/** Only the social channels ride Meta's window; SMS and email do not. */
export function isWindowedChannel(channel: ConversationChannel): boolean {
  return channel === 'messenger' || channel === 'instagram'
}

export type WindowState =
  /** Inside 24h of the last inbound message — free-form replies are allowed. */
  | { status: 'open'; hoursLeft: number }
  /** The lead replied, but more than 24h ago. */
  | { status: 'closed'; lastInboundAt: string }
  /** No inbound message has EVER arrived, so the window never opened. */
  | { status: 'never_opened' }

type ThreadMessage = { direction: string; created_at: string | null }

/**
 * Classify the reply window from the thread's messages.
 *
 * `never_opened` is a real and common state, not an edge case: social threads
 * here often begin with an OUTBOUND message (see the social-DM capture path),
 * so a brand-new lead who has not written back is unreachable on Messenger from
 * the very first moment — worth saying plainly rather than implying a timer.
 */
export function socialWindowState(messages: ThreadMessage[], now: number = Date.now()): WindowState {
  let latestInbound = 0
  let latestInboundAt: string | null = null

  for (const m of messages) {
    if (m.direction !== 'inbound' || !m.created_at) continue
    const t = new Date(m.created_at).getTime()
    // Guard against unparseable timestamps rather than poisoning the max with NaN.
    if (!Number.isFinite(t) || t <= latestInbound) continue
    latestInbound = t
    latestInboundAt = m.created_at
  }

  if (!latestInboundAt) return { status: 'never_opened' }

  const elapsed = now - latestInbound
  if (elapsed >= SOCIAL_WINDOW_MS) return { status: 'closed', lastInboundAt: latestInboundAt }

  return { status: 'open', hoursLeft: (SOCIAL_WINDOW_MS - elapsed) / 3_600_000 }
}

/** What the lead can still be reached on when the social window is shut. */
export type Fallback = { channel: 'sms' | 'email' | 'call'; label: string } | null

/**
 * Pick the single best alternative channel to nudge staff toward.
 *
 * One suggestion, not a menu — this sits inside a warning banner, and a list of
 * options reads as a decision to make rather than a next step to take.
 *
 * SMS over a call when a phone is on file: the lead just went quiet in a text-
 * shaped medium, so a text is the smaller ask and the likelier re-open. That is
 * a sales-floor judgment, not a technical constraint — flip the phone branch to
 * `'call'` if the floor would rather dial. (Booking still needs a call either
 * way; this only reopens the conversation.)
 *
 * Returning null is informative, not a failure: a DM-only lead genuinely has no
 * reachable channel, and saying so is what prompts someone to add a number.
 */
export function suggestFallback(contact: { phone: string | null; email: string | null }): Fallback {
  if (contact.phone) return { channel: 'sms', label: 'a text' }
  if (contact.email) return { channel: 'email', label: 'email' }
  return null
}
