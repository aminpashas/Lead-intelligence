import { describe, it, expect } from 'vitest'
import {
  getAnthropicRate,
  estimateAnthropicCents,
  estimateSmsCents,
  estimateVoiceCents,
  estimateSmsSegments,
  SMS_ESTIMATE_CENTS_PER_SEGMENT,
  VOICE_ESTIMATE_CENTS_PER_MINUTE,
} from '@/lib/billing/pricing'

describe('estimateAnthropicCents', () => {
  it('prices Sonnet 4.6 at $3/$15 per 1M ($0.30/$1.50 per 1K)', () => {
    const cents = estimateAnthropicCents({ model: 'claude-sonnet-4-6', tokensIn: 1000, tokensOut: 1000 })
    expect(cents).toBeCloseTo(0.3 + 1.5, 6) // 1.80¢
  })

  it('prices Haiku 4.5 at $1/$5 per 1M', () => {
    const cents = estimateAnthropicCents({ model: 'claude-haiku-4-5', tokensIn: 10_000, tokensOut: 2_000 })
    expect(cents).toBeCloseTo(1.0 + 1.0, 6) // 2.00¢
  })

  // Regression lock for Bug 1: Opus was priced at stale Opus-3-era $15/$75.
  // Current Opus (4.5/4.6/4.7/4.8) is $5/$25 per 1M = $0.50/$2.50 per 1K.
  it('prices Opus 4.7 at $5/$25 per 1M, NOT the old $15/$75', () => {
    const cents = estimateAnthropicCents({ model: 'claude-opus-4-7', tokensIn: 1000, tokensOut: 1000 })
    expect(cents).toBeCloseTo(0.5 + 2.5, 6) // 3.00¢, not 9.00¢
  })

  it('prices Opus 4.8 at $5/$25 per 1M', () => {
    const cents = estimateAnthropicCents({ model: 'claude-opus-4-8', tokensIn: 1000, tokensOut: 1000 })
    expect(cents).toBeCloseTo(0.5 + 2.5, 6)
  })

  it('applies cache read (0.1x) and cache write (1.25x) multipliers to the input rate', () => {
    const cents = estimateAnthropicCents({
      model: 'claude-sonnet-4-6',
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 10_000, // 10 * 0.30 * 0.10 = 0.30¢
      cacheWriteTokens: 4_000, //  4 * 0.30 * 1.25 = 1.50¢
    })
    expect(cents).toBeCloseTo(0.3 + 1.5, 6) // 1.80¢
  })

  // Regression lock for Bug 2: an unknown model must NOT silently cost $0,
  // or spend on any newly-added model vanishes with no error.
  it('does not return 0 for an unknown model (uses a conservative fallback)', () => {
    const cents = estimateAnthropicCents({ model: 'claude-brand-new-9', tokensIn: 1000, tokensOut: 1000 })
    expect(cents).toBeGreaterThan(0)
  })

  it('flags unknown models via getAnthropicRate().known === false', () => {
    expect(getAnthropicRate('claude-sonnet-4-6').known).toBe(true)
    expect(getAnthropicRate('claude-brand-new-9').known).toBe(false)
  })
})

describe('estimateSmsCents', () => {
  it('multiplies segment count by the per-segment estimate', () => {
    expect(estimateSmsCents(2)).toBeCloseTo(2 * SMS_ESTIMATE_CENTS_PER_SEGMENT, 6)
  })
})

describe('estimateVoiceCents', () => {
  it('prices by fractional minutes', () => {
    expect(estimateVoiceCents(90)).toBeCloseTo(1.5 * VOICE_ESTIMATE_CENTS_PER_MINUTE, 6) // 90s = 1.5 min
  })
})

describe('estimateSmsSegments', () => {
  it('counts a single GSM segment up to 160 chars', () => {
    expect(estimateSmsSegments('x'.repeat(160))).toBe(1)
  })
  it('rolls over to multi-part (153 chars/segment) past 160', () => {
    expect(estimateSmsSegments('x'.repeat(161))).toBe(2)
    expect(estimateSmsSegments('x'.repeat(306))).toBe(2)
    expect(estimateSmsSegments('x'.repeat(307))).toBe(3)
  })
  it('switches to UCS-2 limits (70 single / 67 per part) when non-ASCII present', () => {
    expect(estimateSmsSegments('👍' + 'x'.repeat(68))).toBe(1) // 70 chars (emoji = 2 UTF-16 units)
    expect(estimateSmsSegments('é' + 'x'.repeat(70))).toBe(2) // 71 chars, UCS-2
    expect(estimateSmsSegments('é' + 'x'.repeat(133))).toBe(2) // 134 = 2×67
    expect(estimateSmsSegments('é' + 'x'.repeat(134))).toBe(3)
  })
})
