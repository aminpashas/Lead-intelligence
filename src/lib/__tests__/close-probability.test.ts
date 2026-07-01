import { describe, it, expect } from 'vitest'
import { computeCloseBaseRate, scoreCloseProbability, type CloseProbabilityInput } from '@/lib/pipeline/close-probability'

const NOW = new Date('2026-07-01T00:00:00Z').getTime()

const lead = (o: Partial<CloseProbabilityInput> = {}): CloseProbabilityInput => ({
  ai_qualification: 'warm',
  ai_score: 60,
  total_messages_sent: 0,
  total_messages_received: 0,
  financing_interest: null,
  treatment_value: null,
  no_show_count: 0,
  created_at: '2026-06-20T00:00:00Z',
  ...o,
})

describe('computeCloseBaseRate', () => {
  it('falls back to 0.15 with no leads', () => {
    expect(computeCloseBaseRate([])).toBe(0.15)
  })

  it('is converted / total', () => {
    // contract_signed + completed = 2 converted of 4
    expect(computeCloseBaseRate(['new', 'contract_signed', 'completed', 'lost'])).toBe(0.5)
  })
})

describe('scoreCloseProbability', () => {
  it('scores a hot lead above a cold one', () => {
    const hot = scoreCloseProbability(lead({ ai_qualification: 'hot' }), 0.2, NOW)
    const cold = scoreCloseProbability(lead({ ai_qualification: 'cold' }), 0.2, NOW)
    expect(hot).toBeGreaterThan(cold)
  })

  it('clamps to [0,1]', () => {
    const p = scoreCloseProbability(
      lead({ ai_qualification: 'hot', ai_score: 100, treatment_value: 30000, total_messages_sent: 4, total_messages_received: 4 }),
      0.9,
      NOW
    )
    expect(p).toBeGreaterThanOrEqual(0)
    expect(p).toBeLessThanOrEqual(1)
  })

  it('penalizes a stale lead versus a fresh one (via injected now)', () => {
    const fresh = scoreCloseProbability(lead({ created_at: '2026-06-28T00:00:00Z' }), 0.3, NOW)
    const stale = scoreCloseProbability(lead({ created_at: '2026-01-01T00:00:00Z' }), 0.3, NOW)
    expect(stale).toBeLessThan(fresh)
  })

  it('is deterministic for a fixed now', () => {
    expect(scoreCloseProbability(lead(), 0.2, NOW)).toBe(scoreCloseProbability(lead(), 0.2, NOW))
  })
})
