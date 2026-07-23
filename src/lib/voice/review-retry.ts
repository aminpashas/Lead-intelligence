/**
 * Retry sweep for post-call reviews that never rendered a verdict.
 *
 * `runPostCallReview` deliberately leaves a call at `review_status='pending'`
 * when the model call fails, on the stated contract that "a later sweep can
 * retry it" (post-call-review.ts). That sweep did not exist: `voice-reconcile`
 * only ever selects rows still `initiated|ringing|in_progress`, so the instant a
 * call is finalized its failed review is stranded permanently. A transient
 * 20-second API blip therefore became a permanently unreviewed call — and,
 * because patient-facing issues are what open the `human_task`, a callback the
 * agent promised out loud was silently never queued for anyone.
 *
 * This module is that missing sweep. Selection is pure so it can be unit-tested
 * without Supabase or Anthropic; the runner is budget- and attempt-bounded so a
 * permanently un-reviewable call cannot spin forever or starve the cron.
 *
 * Exhaustion is deliberately NOT a new status: `voice_calls_review_status_check`
 * allows only pending/clear/flagged/escalated, and "pending" is already exactly
 * what the Call Center renders as "Needs Review". A call we give up on should
 * stay visible to a human, so exhausted rows keep `pending` and simply stop
 * being picked up (the attempt counter in metadata is the tombstone).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { VoiceCallOutcome } from '@/types/database'
import { MIN_REVIEW_TRANSCRIPT_CHARS, runPostCallReview } from '@/lib/voice/post-call-review'
import { toTranscriptLines } from '@/lib/voice/transcript'
import { logger } from '@/lib/logger'

/** Give up after this many verdict-less attempts (plus the original try). */
export const MAX_REVIEW_ATTEMPTS = 3

/**
 * Only reach back this far. A review that has been stranded for weeks is a
 * reporting artifact, not an actionable callback, and re-grading old calls would
 * spend tokens re-litigating history every 15 minutes.
 */
export const REVIEW_RETRY_LOOKBACK_DAYS = 14

/** The subset of a voice_calls row this sweep reads. */
export type ReviewRetryRow = {
  id: string
  organization_id: string | null
  lead_id: string | null
  conversation_id: string | null
  retell_call_id: string | null
  direction: string | null
  outcome: string | null
  review_status: string | null
  duration_seconds: number | null
  transcript?: unknown
  metadata?: Record<string, unknown> | null
}

/** Per-row review bookkeeping stashed in voice_calls.metadata. */
export type ReviewMeta = {
  review_attempts: number
  review_last_error: string | null
}

export function readReviewMeta(metadata: Record<string, unknown> | null | undefined): ReviewMeta {
  const m = (metadata ?? {}) as Record<string, unknown>
  return {
    review_attempts: typeof m.review_attempts === 'number' ? m.review_attempts : 0,
    review_last_error: typeof m.review_last_error === 'string' ? m.review_last_error : null,
  }
}

/**
 * Render a stored transcript back into the "Agent: …\nUser: …" text the review
 * prompt expects. Retell stores a plain blob and Twilio Voice Intelligence
 * stores structured turns; `toTranscriptLines` collapses both, and this is the
 * inverse so a retry needs no provider round-trip — we grade what we already
 * persisted rather than re-fetching from Retell.
 */
export function transcriptToPromptText(row: Pick<ReviewRetryRow, 'transcript'>): string {
  return toTranscriptLines({ transcript: row.transcript })
    .map((line) => `${line.role === 'agent' ? 'Agent' : 'User'}: ${line.content}`)
    .join('\n')
}

/**
 * Review statuses that are NOT yet settled, so a call carrying one still needs a
 * verdict. `clear` / `flagged` / `escalated` are terminal. Both of these mean
 * "no verdict yet" and both must be swept:
 *   • `pending` — a review was attempted and left no verdict (model failure).
 *   • `null`    — a review never even started. This happens when a call is
 *                 finalized by a path that doesn't hand off to review (a
 *                 pre-fix reconcile, or a deploy lag where prod still runs the
 *                 old reconciler). Excluding null stranded exactly these calls:
 *                 finalized, transcript in hand, broken_promise ungraded, and
 *                 invisible to the only sweep that could grade them.
 */
const UNSETTLED_REVIEW_STATUSES: (string | null)[] = ['pending', null]

function isUnsettledReview(status: string | null): boolean {
  return UNSETTLED_REVIEW_STATUSES.includes(status)
}

/**
 * True when a stranded review is worth spending another model call on:
 *   • not yet settled (pending OR null — see UNSETTLED_REVIEW_STATUSES),
 *   • an AI call — staff calls carry no agent to grade, and the review rubric
 *     judges "the agent", so grading a human's call would manufacture findings,
 *   • holds enough transcript for the reviewer to have an opinion, and
 *   • hasn't burned its attempt budget.
 */
export function needsReviewRetry(row: ReviewRetryRow): boolean {
  if (!isUnsettledReview(row.review_status)) return false
  if (!row.retell_call_id) return false
  if (readReviewMeta(row.metadata).review_attempts >= MAX_REVIEW_ATTEMPTS) return false
  return transcriptToPromptText(row).trim().length >= MIN_REVIEW_TRANSCRIPT_CHARS
}

/**
 * Narrow a fetched window to this run's batch. Newest first on purpose: a
 * callback promised twenty minutes ago is still recoverable, one promised last
 * Tuesday is already a service failure, so fresh calls get the budget first.
 */
export function selectReviewRetryCandidates(
  rows: ReviewRetryRow[],
  batchSize: number
): ReviewRetryRow[] {
  return rows.filter(needsReviewRetry).slice(0, Math.max(0, batchSize))
}

export type ReviewRetryResult = {
  checked: number
  retried: number
  settled: number
  deferred: number
  /** Set when a provider-wide fault ended the sweep early. Surfaced in cron output. */
  abandonedReason?: string
}

/**
 * Re-run the review pipeline over stranded rows. Never throws — this runs at the
 * tail of a cron whose primary job (finalizing calls) has already succeeded, and
 * must not turn a partial recovery into a failed cron run.
 */
export async function retryStrandedReviews(
  supabase: SupabaseClient,
  opts: { budgetMs: number; batchSize?: number }
): Promise<ReviewRetryResult> {
  const result: ReviewRetryResult = { checked: 0, retried: 0, settled: 0, deferred: 0 }
  if (opts.budgetMs <= 0) return result

  const startedAt = Date.now()
  const since = new Date(Date.now() - REVIEW_RETRY_LOOKBACK_DAYS * 86_400_000).toISOString()

  try {
    const { data, error } = await supabase
      .from('voice_calls')
      .select(
        'id, organization_id, lead_id, conversation_id, retell_call_id, direction, ' +
          'outcome, review_status, duration_seconds, transcript, metadata'
      )
      // Unsettled = pending OR null; both mean "no verdict yet" (see
      // UNSETTLED_REVIEW_STATUSES). Keep this in lockstep with needsReviewRetry —
      // widening one without the other either never fetches the row or fetches
      // then silently drops it.
      .or('review_status.is.null,review_status.eq.pending')
      .not('ended_at', 'is', null)
      .gte('ended_at', since)
      .order('ended_at', { ascending: false })
      .limit(100)

    if (error) {
      logger.warn('ReviewRetry: candidate query failed', { error: error.message })
      return result
    }

    const rows = (data || []) as unknown as ReviewRetryRow[]
    result.checked = rows.length
    const batch = selectReviewRetryCandidates(rows, opts.batchSize ?? 10)

    for (const row of batch) {
      if (Date.now() - startedAt > opts.budgetMs) {
        result.deferred++
        continue
      }

      // Bump the counter BEFORE the attempt. If the function is killed mid-review
      // (timeout, OOM) the row still shows the try, so a permanently fatal call
      // walks its budget down instead of being retried every 15 minutes forever.
      const meta = readReviewMeta(row.metadata)
      const attempts = meta.review_attempts + 1
      await supabase
        .from('voice_calls')
        .update({ metadata: { ...(row.metadata || {}), review_attempts: attempts } })
        .eq('id', row.id)

      const review = await runPostCallReview(supabase, {
        callId: row.id,
        organizationId: row.organization_id,
        leadId: row.lead_id,
        conversationId: row.conversation_id,
        retellCallId: row.retell_call_id!,
        direction: row.direction === 'outbound' ? 'outbound' : 'inbound',
        transcript: transcriptToPromptText(row),
        durationSeconds: row.duration_seconds ?? 0,
        disconnectionReason: (row.metadata?.disconnection_reason as string | null) ?? null,
        currentOutcome: (row.outcome as VoiceCallOutcome | null) ?? null,
      })
      result.retried++

      // A provider-wide fault (quota exhausted, rate limit, 5xx) says nothing
      // about this call — every call is failing identically. Charging it an
      // attempt would walk the ENTIRE backlog to exhaustion in three ticks and
      // tombstone it for an outage it had no part in, so refund the attempt and
      // abandon the rest of the batch: the next call would fail the same way.
      if (review.status === 'failed' && review.kind === 'systemic') {
        await supabase
          .from('voice_calls')
          .update({
            metadata: {
              ...(row.metadata || {}),
              review_attempts: meta.review_attempts,
              review_last_error: review.reason.slice(0, 300),
            },
          })
          .eq('id', row.id)
        result.retried--
        result.abandonedReason = review.reason.slice(0, 200)
        logger.warn('ReviewRetry: provider fault — refunded attempt, ending sweep', {
          call_id: row.id,
          reason: review.reason,
        })
        break
      }

      if (review.status === 'failed') {
        // Call-specific: the attempt legitimately counts. Record the real reason
        // so an exhausted row explains itself instead of looking mysteriously
        // stuck. The typed result is authoritative — no read-back needed, and a
        // generic "no verdict" message here would only bury the actual error.
        await supabase
          .from('voice_calls')
          .update({
            metadata: {
              ...(row.metadata || {}),
              review_attempts: attempts,
              review_last_error: review.reason.slice(0, 300),
            },
          })
          .eq('id', row.id)
        logger.warn('ReviewRetry: attempt rendered no verdict', {
          call_id: row.id,
          attempts,
          reason: review.reason,
        })
        continue
      }

      if (review.status === 'reviewed') result.settled++
    }

    if (result.retried) {
      logger.info('ReviewRetry: swept stranded reviews', { ...result })
    }
  } catch (err) {
    logger.warn('ReviewRetry: sweep threw (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return result
}
