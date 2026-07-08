import { describe, it, expect } from 'vitest'
import {
  buildCoverageLine, pickAffordableTerm, monthlyPaymentFor,
} from '@/lib/financing/coverage-line'
import type { LenderPrequalOffer, LenderTermOption } from '@/lib/financing/prequal-types'

const promoTerm: LenderTermOption = { apr: 0, term_months: 12, promo_period_months: 12 }
const longTerm: LenderTermOption = { apr: 9.99, term_months: 24, promo_period_months: 0 }

// Cherry offers a 0%/12mo promo OR a 9.99%/24mo term.
const cherry: LenderPrequalOffer = {
  lender_slug: 'cherry',
  lender_name: 'Cherry',
  decision: 'approved',
  approved_amount: 15000,
  terms: [promoTerm, longTerm],
}

describe('buildCoverageLine', () => {
  it('computes an exact monthly payment for a 0% promo term (principal / term)', () => {
    const line = buildCoverageLine(cherry, 15000, promoTerm)
    expect(line.amount).toBe(15000)
    expect(line.monthly_payment).toBe(1250) // 15000 / 12
    expect(line.is_promo).toBe(true)
    expect(line.term_months).toBe(12)
    expect(line.lender_slug).toBe('cherry')
  })

  it('reflects the chosen term and the allocated amount (not the approved cap)', () => {
    const line = buildCoverageLine(cherry, 10000, longTerm) // draw 10k on the 24mo term
    expect(line.amount).toBe(10000)
    expect(line.apr).toBe(9.99)
    expect(line.term_months).toBe(24)
    expect(line.is_promo).toBe(false)
    expect(line.monthly_payment).toBeGreaterThan(0)
  })
})

describe('monthlyPaymentFor', () => {
  it('a longer term yields a lower monthly payment for the same principal', () => {
    expect(monthlyPaymentFor(15000, longTerm)).toBeLessThan(monthlyPaymentFor(15000, promoTerm))
  })
})

describe('pickAffordableTerm', () => {
  it('picks the longest term (lowest required monthly payment)', () => {
    // longest of [12, 24] = 24mo (~$692/mo vs the 0%/12mo ~$1250/mo).
    expect(pickAffordableTerm(cherry, 15000).term_months).toBe(24)
  })

  it('throws when a lender has no term options', () => {
    const noTerms: LenderPrequalOffer = { ...cherry, terms: [] }
    expect(() => pickAffordableTerm(noTerms, 15000)).toThrow()
  })
})
