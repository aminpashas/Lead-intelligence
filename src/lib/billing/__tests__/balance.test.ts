import { describe, it, expect } from 'vitest'
import { computeLowThreshold, DEFAULT_RELOAD_CENTS } from '@/lib/billing/balance'

describe('computeLowThreshold', () => {
  it('is 10% of the reload amount by default', () => {
    expect(computeLowThreshold(50_000, 10)).toBe(5_000) // $500 reload → reload at $50
    expect(computeLowThreshold(DEFAULT_RELOAD_CENTS, 10)).toBe(5_000)
  })

  it('scales with the configured percent', () => {
    expect(computeLowThreshold(100_000, 25)).toBe(25_000)
    expect(computeLowThreshold(100_000, 0)).toBe(0)
  })

  it('never goes negative', () => {
    expect(computeLowThreshold(-100, 10)).toBe(0)
    expect(computeLowThreshold(1000, -5)).toBe(0)
  })
})
