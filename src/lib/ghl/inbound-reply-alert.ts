/**
 * Speed-to-reply gate for GHL-mirrored inbound messages.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A Facebook/Instagram DM can only be answered by the Page within Meta's
 * 24-hour messaging window, and that clock RESETS on every inbound message. If
 * staff don't see a reply in time the thread becomes permanently unsendable
 * (see src/lib/messaging/social-window.ts + src/lib/ghl/social-send-guards.ts).
 *
 * `notifyNewLead` already fires on the FIRST inbound DM (which mints the lead).
 * This gate covers every SUBSEQUENT reply from a lead we already have — the
 * event that reopens a window nobody was watching.
 *
 * ── Why it must be freshness-gated ──────────────────────────────────────────
 * The alert is called from two places that share one persist path:
 *   • the go-forward webhook (one message, just arrived)  — always fresh
 *   • the live-tail poller / backfill sweep               — re-reads whole
 *     threads, including months-old history
 * Without a freshness check, a re-sweep of old threads would blast staff with
 * alerts for messages from weeks ago — the same stale-replay bug `notifyNewLead`
 * guards against with `sourceCreatedAt`. So the gate keys off the DM's own
 * timestamp, not the fact that it was just inserted into our DB.
 *
 * Pure and side-effect free so the rule is unit-testable without Supabase, GHL,
 * or a notification transport.
 */
import { SOCIAL_CHANNELS } from '@/lib/channels'
import type { NormalizedGhlMessage } from './conversations'

/**
 * How recent an inbound DM must be (relative to now) to still warrant a
 * real-time staff ping.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  DECISION POINT — this threshold is a genuine product judgment, not a
 *  mechanical default. It trades two failure modes against each other:
 *
 *    • TOO TIGHT  → a legitimately-new reply that reaches us a little late
 *      (slow GHL webhook, cron cadence, a brief ingest hiccup) is treated as
 *      "old" and silently NOT alerted — staff miss the window anyway.
 *    • TOO LOOSE  → a historical re-sweep or a delayed backfill re-alerts on
 *      messages that are hours/days old, blasting staff with stale pings.
 *
 *  Anchor it to how the ingest paths actually run:
 *    - the live-tail poller's cron interval (how stale can a "new" message be
 *      by the time the poll picks it up?)
 *    - realistic webhook + retry latency
 *  ...while staying comfortably SHORTER than Meta's 24h window (a ping only
 *  helps if it still leaves time to reply).
 * ─────────────────────────────────────────────────────────────────────────
 */
export const INBOUND_REPLY_ALERT_MAX_AGE_MS = 30 * 60 * 1000 // 30 minutes

type PersistStatus = 'inserted' | 'skipped' | 'call_logged'

/**
 * Decide whether a just-persisted GHL message should fire a speed-to-reply
 * staff alert. Returns false for everything that isn't a fresh, inbound social
 * reply from a pre-existing lead.
 */
export function shouldAlertInboundReply(params: {
  normalized: NormalizedGhlMessage
  /** Result of persistGhlMessage — only a brand-new row can be worth alerting. */
  persistStatus: PersistStatus
  /** True when THIS message just created the lead (notifyNewLead already fired). */
  leadCreatedNow: boolean
  /** Epoch millis "now"; injected so the rule is deterministic in tests. */
  now: number
  /** Override the freshness budget (tests); defaults to the constant above. */
  maxAgeMs?: number
}): boolean {
  const { normalized, persistStatus, leadCreatedNow, now } = params
  const maxAgeMs = params.maxAgeMs ?? INBOUND_REPLY_ALERT_MAX_AGE_MS

  // Idempotent re-delivery / non-message rows were already skipped upstream.
  if (persistStatus !== 'inserted') return false
  // Only the patient's own messages — never our outbound mirror.
  if (normalized.direction !== 'inbound') return false
  // The first inbound from a brand-new social lead already alerted via
  // notifyNewLead; a second ping here would double-fire on lead creation.
  if (leadCreatedNow) return false
  // Social DMs only. This is where the 24h deadline bites; inbound SMS/email
  // have no send window, and for direct numbers already alert via the
  // Twilio/Resend webhooks. Widen this set here if that ever changes.
  if (normalized.channel === null) return false
  if (!(SOCIAL_CHANNELS as readonly string[]).includes(normalized.channel)) return false
  // Freshness: alert only on messages recent enough that a reply still helps —
  // see INBOUND_REPLY_ALERT_MAX_AGE_MS. Guards the poller/backfill replay case.
  const createdMs = Date.parse(normalized.createdAt)
  if (Number.isNaN(createdMs)) return false
  return now - createdMs <= maxAgeMs
}
