import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  needsReviewRetry,
  readReviewMeta,
  selectReviewRetryCandidates,
  transcriptToPromptText,
  MAX_REVIEW_ATTEMPTS,
  retryStrandedReviews,
  type ReviewRetryRow,
} from '../review-retry'
import * as review from '../post-call-review'
import { classifyReviewFailure } from '../post-call-review'

// Only runPostCallReview is faked; classifyReviewFailure and the transcript
// floor stay real so the tests exercise the genuine thresholds.
vi.mock('../post-call-review', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../post-call-review')>()),
  runPostCallReview: vi.fn(),
}))

/** Comfortably over MIN_REVIEW_TRANSCRIPT_CHARS (120). */
const LONG_TRANSCRIPT =
  'Agent: Hi there, thanks for calling the practice today.\n' +
  'User: Hi, I wanted to check on the status of a form I sent in last week.\n' +
  'Agent: Let me have someone look into that and call you back today.\n' +
  'User: Great, thank you so much.'

function row(overrides: Partial<ReviewRetryRow> = {}): ReviewRetryRow {
  return {
    id: 'call-1',
    organization_id: 'org-1',
    lead_id: 'lead-1',
    conversation_id: 'conv-1',
    retell_call_id: 'call_abc',
    direction: 'inbound',
    outcome: 'interested',
    review_status: 'pending',
    duration_seconds: 130,
    transcript: LONG_TRANSCRIPT,
    metadata: {},
    ...overrides,
  }
}

describe('readReviewMeta', () => {
  it('defaults a missing counter to zero', () => {
    expect(readReviewMeta(null)).toEqual({ review_attempts: 0, review_last_error: null })
    expect(readReviewMeta({ review_attempts: 'two' })).toMatchObject({ review_attempts: 0 })
  })

  it('reads a real counter', () => {
    expect(readReviewMeta({ review_attempts: 2 })).toMatchObject({ review_attempts: 2 })
  })
})

describe('transcriptToPromptText', () => {
  it('passes a Retell text blob through as role-tagged lines', () => {
    const text = transcriptToPromptText({ transcript: LONG_TRANSCRIPT })
    expect(text).toContain('Agent: Hi there, thanks for calling the practice today.')
    expect(text).toContain('User: Hi, I wanted to check on the status of a form I sent in last week.')
  })

  it('renders structured Twilio turns into the same shape', () => {
    const text = transcriptToPromptText({
      transcript: [
        { role: 'agent', content: 'Hello?' },
        { role: 'lead', content: 'Hi there.' },
      ],
    })
    expect(text).toBe('Agent: Hello?\nUser: Hi there.')
  })

  it('is empty when there is no transcript', () => {
    expect(transcriptToPromptText({ transcript: null })).toBe('')
    expect(transcriptToPromptText({ transcript: [] })).toBe('')
  })
})

describe('needsReviewRetry', () => {
  it('retries a stranded AI call with a usable transcript', () => {
    expect(needsReviewRetry(row())).toBe(true)
  })

  it('skips settled verdicts', () => {
    for (const review_status of ['clear', 'flagged', 'escalated']) {
      expect(needsReviewRetry(row({ review_status }))).toBe(false)
    }
  })

  it('retries a review that never started (null), not just one that failed (pending)', () => {
    // A call finalized by a path that skips review — a pre-fix reconcile, or a
    // deploy lag where prod still runs the old reconciler — lands at null with a
    // transcript in hand. That is exactly as stranded as a failed 'pending', and
    // its broken_promise finding is exactly as lost, so the sweep must grade it.
    expect(needsReviewRetry(row({ review_status: null }))).toBe(true)
  })

  it('skips staff calls — the rubric grades an AI agent that was never on the call', () => {
    expect(needsReviewRetry(row({ retell_call_id: null }))).toBe(false)
  })

  it('skips calls with too little transcript to have an opinion about', () => {
    expect(needsReviewRetry(row({ transcript: 'Agent: Hello?' }))).toBe(false)
    expect(needsReviewRetry(row({ transcript: null }))).toBe(false)
  })

  it('stops at the attempt ceiling so a fatal call cannot spin forever', () => {
    expect(needsReviewRetry(row({ metadata: { review_attempts: MAX_REVIEW_ATTEMPTS - 1 } }))).toBe(true)
    expect(needsReviewRetry(row({ metadata: { review_attempts: MAX_REVIEW_ATTEMPTS } }))).toBe(false)
    expect(needsReviewRetry(row({ metadata: { review_attempts: MAX_REVIEW_ATTEMPTS + 5 } }))).toBe(false)
  })
})

describe('selectReviewRetryCandidates', () => {
  it('filters out ineligible rows and caps the batch', () => {
    const rows = [
      row({ id: 'a' }),
      row({ id: 'b', review_status: 'clear' }),
      row({ id: 'c' }),
      row({ id: 'd', retell_call_id: null }),
      row({ id: 'e' }),
    ]
    expect(selectReviewRetryCandidates(rows, 2).map((r) => r.id)).toEqual(['a', 'c'])
    expect(selectReviewRetryCandidates(rows, 10).map((r) => r.id)).toEqual(['a', 'c', 'e'])
  })

  it('preserves caller ordering, which the query sets to newest-ended first', () => {
    const rows = [row({ id: 'newest' }), row({ id: 'older' })]
    expect(selectReviewRetryCandidates(rows, 10).map((r) => r.id)).toEqual(['newest', 'older'])
  })

  it('returns nothing for a non-positive batch size', () => {
    expect(selectReviewRetryCandidates([row()], 0)).toEqual([])
  })
})

describe('classifyReviewFailure', () => {
  it('treats provider-wide faults as systemic, so they never burn a call\'s budget', () => {
    for (const reason of [
      'You have reached your specified API usage limits. You will regain access on 2026-08-01',
      'rate_limit_error: too many requests',
      'Your credit balance is too low',
      '529 overloaded_error',
      'fetch failed',
      'ETIMEDOUT',
      '503 Service Unavailable',
    ]) {
      expect(classifyReviewFailure(reason)).toBe('systemic')
    }
  })

  it('treats a bad answer about this call as call-specific', () => {
    expect(classifyReviewFailure('unparseable model output')).toBe('call_specific')
    expect(classifyReviewFailure('prompt is too long for this transcript')).toBe('call_specific')
  })
})

describe('retryStrandedReviews — outage safety', () => {
  /** Supabase stub that serves one pending row and records metadata writes. */
  function stub(rows: Record<string, unknown>[]) {
    const updates: Record<string, unknown>[] = []
    const client = {
      from() {
        const qb: Record<string, unknown> = {
          select: () => qb,
          eq: () => qb,
          or: () => qb,
          not: () => qb,
          gte: () => qb,
          order: () => qb,
          limit: () => Promise.resolve({ data: rows, error: null }),
          maybeSingle: () => Promise.resolve({ data: { review_status: 'pending' }, error: null }),
          update(patch: Record<string, unknown>) {
            updates.push(patch)
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
        return qb
      },
    }
    return { client: client as never, updates }
  }

  const pendingRow = {
    id: 'call-x',
    organization_id: 'org-1',
    lead_id: 'lead-1',
    conversation_id: null,
    retell_call_id: 'rc_1',
    direction: 'inbound',
    outcome: 'callback_requested',
    review_status: 'pending',
    duration_seconds: 150,
    transcript: LONG_TRANSCRIPT,
    metadata: { review_attempts: 1 },
  }

  afterEach(() => vi.restoreAllMocks())

  const attemptsWritten = (updates: Record<string, unknown>[]) =>
    updates
      .map((u) => (u.metadata as Record<string, unknown> | undefined)?.review_attempts)
      .filter((v) => v !== undefined)

  it('refunds the attempt and ends the sweep when the provider is down', async () => {
    // Stub the verdict rather than relying on an unset ANTHROPIC_API_KEY: the key
    // IS present in some local envs, which would silently turn this into a live
    // API call that succeeds and tests nothing.
    vi.mocked(review.runPostCallReview).mockResolvedValue({
      status: 'failed',
      reason: '429 rate_limit_error: too many requests',
      kind: 'systemic',
    })

    const { client, updates } = stub([pendingRow])
    const result = await retryStrandedReviews(client, { budgetMs: 5_000 })

    // Bumped to 2 pre-flight, then refunded back to 1 — an outage must not spend
    // this call's finite budget.
    expect(attemptsWritten(updates)).toEqual([2, 1])
    expect(result.retried).toBe(0)
    expect(result.abandonedReason).toContain('rate_limit')
  })

  it('charges the attempt when the failure is about this call', async () => {
    vi.mocked(review.runPostCallReview).mockResolvedValue({
      status: 'failed',
      reason: 'unparseable model output',
      kind: 'call_specific',
    })

    const { client, updates } = stub([pendingRow])
    const result = await retryStrandedReviews(client, { budgetMs: 5_000 })

    // Stays at 2: a transcript the model can't grade should walk its budget down.
    expect(attemptsWritten(updates)).toEqual([2, 2])
    expect(result.retried).toBe(1)
    expect(result.settled).toBe(0)
  })
})
