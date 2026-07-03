import { describe, it, expect } from 'vitest'
import { computeBillable, resolveMarkupPct, DEFAULT_MARKUP_PCT } from '@/lib/billing/markup'

describe('DEFAULT_MARKUP_PCT', () => {
  it('marks AI up highest, telephony lower (agency re-bill defaults)', () => {
    expect(DEFAULT_MARKUP_PCT).toEqual({ ai: 50, sms: 40, voice: 30, email: 40 })
  })
})

describe('computeBillable', () => {
  it('applies the default per-service markup and snapshots the pct', () => {
    expect(computeBillable(100, 'ai')).toEqual({ billableCents: 150, markupPct: 50 })
    expect(computeBillable(100, 'sms')).toEqual({ billableCents: 140, markupPct: 40 })
    expect(computeBillable(100, 'voice')).toEqual({ billableCents: 130, markupPct: 30 })
  })

  it('uses a per-practice override when present', () => {
    expect(computeBillable(100, 'ai', { markups: { ai: 20 } })).toEqual({ billableCents: 120, markupPct: 20 })
  })

  it('applies an override to only its own service, defaults for the rest', () => {
    const cfg = { markups: { ai: 20 } }
    expect(computeBillable(100, 'sms', cfg).billableCents).toBe(140) // still default 40%
  })

  it('respects a genuine 0% markup (re-bill at cost)', () => {
    expect(computeBillable(100, 'ai', { markups: { ai: 0 } })).toEqual({ billableCents: 100, markupPct: 0 })
  })

  it('falls back to the default for an invalid override (negative / NaN)', () => {
    expect(computeBillable(100, 'ai', { markups: { ai: -10 } }).markupPct).toBe(50)
    expect(computeBillable(100, 'ai', { markups: { ai: Number.NaN } }).markupPct).toBe(50)
  })

  it('preserves fractional cents (no per-event rounding)', () => {
    expect(computeBillable(0.03, 'ai').billableCents).toBeCloseTo(0.045, 6)
  })

  it('handles zero cost', () => {
    expect(computeBillable(0, 'voice').billableCents).toBe(0)
  })
})

describe('resolveMarkupPct', () => {
  it('returns the default when config is null/undefined', () => {
    expect(resolveMarkupPct('sms', null)).toBe(40)
    expect(resolveMarkupPct('sms', undefined)).toBe(40)
  })
})
