import { describe, it, expect } from 'vitest'
import { priceUsage, costMultiple, type UsageQuantities } from '@/lib/billing/usage-live'

const EMPTY: UsageQuantities = {
  smsOutCount: 0,
  smsOutSegments: 0,
  smsInCount: 0,
  emailOutCount: 0,
  voiceSeconds: 0,
  voiceCalls: 0,
  aiCalls: 0,
  aiTokensIn: 0,
  aiTokensOut: 0,
  aiCostCents: 0,
}

describe('priceUsage', () => {
  it('prices SMS from outbound segments + inbound at 1.1¢, re-billed 3× by default', () => {
    const q = { ...EMPTY, smsOutSegments: 100, smsInCount: 20 }
    const s = priceUsage(q)
    expect(s.sms.costCents).toBeCloseTo(120 * 1.1, 6) // 120 segments × 1.1¢
    expect(s.sms.billableCents).toBeCloseTo(120 * 1.1 * 3, 6) // default 200% markup = 3× cost
    expect(s.sms.markupPct).toBe(200)
  })

  it('passes AI provider cost through from ai_usage.cost_cents and re-bills 3×', () => {
    const q = { ...EMPTY, aiCostCents: 25 }
    const s = priceUsage(q)
    expect(s.ai.costCents).toBe(25)
    expect(s.ai.billableCents).toBeCloseTo(75, 6)
  })

  it('prices voice from seconds at 8¢/min', () => {
    const q = { ...EMPTY, voiceSeconds: 120 } // 2 min
    const s = priceUsage(q)
    expect(s.voice.costCents).toBeCloseTo(16, 6) // 2 × 8¢
    expect(s.voice.billableCents).toBeCloseTo(48, 6)
  })

  it('honors a per-practice markup override on one service only', () => {
    const q = { ...EMPTY, smsOutSegments: 100, aiCostCents: 10 }
    const s = priceUsage(q, { markups: { sms: 0 } })
    expect(s.sms.billableCents).toBeCloseTo(100 * 1.1, 6) // 0% → at cost
    expect(s.ai.billableCents).toBeCloseTo(30, 6) // still default 200%
  })
})

describe('costMultiple', () => {
  it('turns a markup percent into the multiple of cost billed', () => {
    expect(costMultiple(200)).toBe(3)
    expect(costMultiple(0)).toBe(1)
    expect(costMultiple(50)).toBe(1.5)
  })
})
