import { describe, it, expect } from 'vitest'
import { buildCoverageLine } from '@/lib/financing/coverage-line'
import type { LenderPrequalOffer } from '@/lib/financing/prequal-types'

const promoOffer: LenderPrequalOffer = {
  lender_slug: 'cherry',
  lender_name: 'Cherry',
  decision: 'approved',
  approved_amount: 15000,
  apr: 0,
  term_months: 12,
  promo_period_months: 12,
}

const interestOffer: LenderPrequalOffer = {
  lender_slug: 'proceed',
  lender_name: 'Proceed Finance',
  decision: 'approved',
  approved_amount: 20000,
  apr: 9.9,
  term_months: 60,
  promo_period_months: 0,
}

describe('buildCoverageLine', () => {
  it('computes an exact monthly payment for a 0% promo line (principal / term)', () => {
    const line = buildCoverageLine(promoOffer, 15000)
    expect(line.amount).toBe(15000)
    expect(line.monthly_payment).toBe(1250) // 15000 / 12
    expect(line.is_promo).toBe(true)
    expect(line.lender_slug).toBe('cherry')
  })

  it('computes an amortized monthly payment for an interest-bearing partial draw', () => {
    const line = buildCoverageLine(interestOffer, 20000)
    // 20000 @ 9.9% / 60mo standard amortization ≈ $424/mo
    expect(line.monthly_payment).toBeCloseTo(424, 0)
    expect(line.is_promo).toBe(false)
    expect(line.apr).toBe(9.9)
  })

  it('uses the allocated amount, not the approved cap', () => {
    const line = buildCoverageLine(interestOffer, 10000) // draw less than approved 20000
    expect(line.amount).toBe(10000)
    expect(line.monthly_payment).toBeCloseTo(212, 0) // half of the full-draw payment
  })
})
