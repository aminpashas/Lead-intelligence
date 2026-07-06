/**
 * Provider rate card — the single source of truth for what Lead Intelligence PAYS.
 *
 * Anthropic never pushes a per-request dollar figure, so AI cost is *computed* from the
 * token counts on each response's `usage` object. Twilio (SMS) and Retell (voice) DO report
 * an actual `price`/cost asynchronously, so those rates are estimate-only fallbacks used at
 * send time and later overwritten by the real figure (see cost-events reconciliation).
 *
 * All figures are in US cents. AI rates are cents-per-1K-tokens (matches ai_usage.cost_cents).
 * Sources: Anthropic pricing table (Opus 4.6/4.7/4.8 $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5).
 * Update when prices change — actual billing is always reconciled against the provider invoice.
 */

export type AnthropicRate = { in: number; out: number } // cents per 1K tokens

/** Cache-token pricing is expressed as a multiplier on the model's INPUT rate. */
export const CACHE_READ_MULTIPLIER = 0.1 // cache reads ≈ 0.1× input
export const CACHE_WRITE_MULTIPLIER = 1.25 // 5-minute cache writes ≈ 1.25× input

/** cents per 1K tokens = ($/1M) / 10. */
const ANTHROPIC_RATES: Record<string, AnthropicRate> = {
  'claude-haiku-4-5': { in: 0.1, out: 0.5 }, //  $1 / $5  per 1M
  'claude-3-5-haiku-20241022': { in: 0.1, out: 0.5 }, // $1 / $5 (retired; kept for legacy rows)
  'claude-sonnet-4-5': { in: 0.3, out: 1.5 }, // $3 / $15 per 1M (legacy)
  'claude-sonnet-4-6': { in: 0.3, out: 1.5 }, // $3 / $15 per 1M
  'claude-sonnet-5': { in: 0.3, out: 1.5 }, //   $3 / $15 per 1M (intro $2/$10 through 2026-08-31)
  // Opus 4.0/4.1 were genuinely $15/$75. The old ai_usage table erroneously applied that
  // same rate to Opus 4.5/4.7 — which are $5/$25. Both are represented correctly here.
  'claude-opus-4': { in: 1.5, out: 7.5 }, //    $15 / $75 per 1M (Opus 4.0, legacy)
  'claude-opus-4-0': { in: 1.5, out: 7.5 }, //  $15 / $75 per 1M (legacy)
  'claude-opus-4-1': { in: 1.5, out: 7.5 }, //  $15 / $75 per 1M (legacy)
  'claude-opus-4-5': { in: 0.5, out: 2.5 }, //  $5 / $25 per 1M
  'claude-opus-4-6': { in: 0.5, out: 2.5 }, //  $5 / $25 per 1M
  'claude-opus-4-7': { in: 0.5, out: 2.5 }, //  $5 / $25 per 1M
  'claude-opus-4-8': { in: 0.5, out: 2.5 }, //  $5 / $25 per 1M
}

/**
 * Conservative fallback for an unmapped model. Sonnet-tier rate — high enough that a newly
 * released model still books a realistic, non-zero cost instead of silently vanishing from
 * the ledger. Callers should flag `known === false` so the gap gets noticed and the table updated.
 */
const FALLBACK_RATE: AnthropicRate = { in: 0.3, out: 1.5 }

export function getAnthropicRate(model: string): AnthropicRate & { known: boolean } {
  const rate = ANTHROPIC_RATES[model]
  if (rate) return { ...rate, known: true }
  return { ...FALLBACK_RATE, known: false }
}

export function estimateAnthropicCents(args: {
  model: string
  tokensIn: number
  tokensOut: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}): number {
  const rate = getAnthropicRate(args.model)
  const cacheRead = args.cacheReadTokens ?? 0
  const cacheWrite = args.cacheWriteTokens ?? 0
  return (
    (args.tokensIn / 1000) * rate.in +
    (args.tokensOut / 1000) * rate.out +
    (cacheRead / 1000) * rate.in * CACHE_READ_MULTIPLIER +
    (cacheWrite / 1000) * rate.in * CACHE_WRITE_MULTIPLIER
  )
}

/**
 * Twilio SMS fallback estimate (US A2P 10DLC): ~$0.0079 carrier + ~$0.003 A2P surcharge per
 * outbound segment ≈ 1.1¢. Overwritten by Twilio's real `price` on the status callback.
 */
export const SMS_ESTIMATE_CENTS_PER_SEGMENT = 1.1

/**
 * Retell voice fallback estimate: combined engine + telephony ≈ $0.08/min.
 * Overwritten by Retell's reported cost on the call-ended webhook.
 */
export const VOICE_ESTIMATE_CENTS_PER_MINUTE = 8

/**
 * Resend email fallback estimate: blended ≈ $0.0004 per send (the $20 / 50k-email tier).
 * Email has no per-message provider callback, so this estimate is what the ledger/live rollup use.
 */
export const EMAIL_ESTIMATE_CENTS_PER_SEND = 0.04

export function estimateEmailCents(count: number): number {
  return Math.max(0, count) * EMAIL_ESTIMATE_CENTS_PER_SEND
}

export function estimateSmsCents(segments: number): number {
  return Math.max(0, segments) * SMS_ESTIMATE_CENTS_PER_SEGMENT
}

export function estimateVoiceCents(seconds: number): number {
  return (Math.max(0, seconds) / 60) * VOICE_ESTIMATE_CENTS_PER_MINUTE
}

/**
 * Rough GSM-7 segment count for pre-send SMS estimates. A single segment holds 160 chars;
 * concatenated messages hold 153 each. Twilio's actual `num_segments` (which also accounts for
 * UCS-2/emoji encoding) overrides this at reconciliation time.
 */
export function estimateSmsSegments(body: string): number {
  const len = body.length
  if (len === 0) return 0
  if (len <= 160) return 1
  return Math.ceil(len / 153)
}
