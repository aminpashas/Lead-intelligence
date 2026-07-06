import { describe, it, expect } from 'vitest'
import {
  computeBillable,
  resolveMarkupPct,
  DEFAULT_MARKUP_PCT,
  DEFAULT_PLATFORM_FEE_CENTS,
  resolvePlatformFeeCents,
} from '@/lib/billing/markup'

describe('DEFAULT_MARKUP_PCT', () => {
  it('re-bills every service at a flat 3× cost (200% markup house default)', () => {
    expect(DEFAULT_MARKUP_PCT).toEqual({ ai: 200, sms: 200, voice: 200, email: 200 })
  })
})

describe('computeBillable', () => {
  it('applies the default 3× (200%) markup and snapshots the pct', () => {
    expect(computeBillable(100, 'ai')).toEqual({ billableCents: 300, markupPct: 200 })
    expect(computeBillable(100, 'sms')).toEqual({ billableCents: 300, markupPct: 200 })
    expect(computeBillable(100, 'voice')).toEqual({ billableCents: 300, markupPct: 200 })
  })

  it('uses a per-practice override when present', () => {
    expect(computeBillable(100, 'ai', { markups: { ai: 20 } })).toEqual({ billableCents: 120, markupPct: 20 })
  })

  it('applies an override to only its own service, defaults for the rest', () => {
    const cfg = { markups: { ai: 20 } }
    expect(computeBillable(100, 'sms', cfg).billableCents).toBe(300) // still default 200%
  })

  it('respects a genuine 0% markup (re-bill at cost)', () => {
    expect(computeBillable(100, 'ai', { markups: { ai: 0 } })).toEqual({ billableCents: 100, markupPct: 0 })
  })

  it('falls back to the default for an invalid override (negative / NaN)', () => {
    expect(computeBillable(100, 'ai', { markups: { ai: -10 } }).markupPct).toBe(200)
    expect(computeBillable(100, 'ai', { markups: { ai: Number.NaN } }).markupPct).toBe(200)
  })

  it('preserves fractional cents (no per-event rounding)', () => {
    expect(computeBillable(0.03, 'ai').billableCents).toBeCloseTo(0.09, 6)
  })

  it('handles zero cost', () => {
    expect(computeBillable(0, 'voice').billableCents).toBe(0)
  })
})

describe('resolveMarkupPct', () => {
  it('returns the default when config is null/undefined', () => {
    expect(resolveMarkupPct('sms', null)).toBe(200)
    expect(resolveMarkupPct('sms', undefined)).toBe(200)
  })
})

describe('resolvePlatformFeeCents', () => {
  it('defaults to $1,500/mo when nothing is stored', () => {
    expect(DEFAULT_PLATFORM_FEE_CENTS).toBe(150_000)
    expect(resolvePlatformFeeCents(undefined)).toBe(150_000)
    expect(resolvePlatformFeeCents(null)).toBe(150_000)
  })

  it('honors a stored fee, including an explicit $0', () => {
    expect(resolvePlatformFeeCents(50_000)).toBe(50_000)
    expect(resolvePlatformFeeCents(0)).toBe(0)
  })

  it('falls back to the default for an invalid stored value', () => {
    expect(resolvePlatformFeeCents(-1)).toBe(150_000)
    expect(resolvePlatformFeeCents(Number.NaN)).toBe(150_000)
  })
})
