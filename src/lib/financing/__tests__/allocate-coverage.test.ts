import { describe, it, expect } from 'vitest'
import { allocateCoverage, orderOffersForStrategy } from '@/lib/financing/allocate-coverage'
import type { LenderPrequalOffer } from '@/lib/financing/prequal-types'

// Cherry: 0%/12 OR 9.99%/24. Approved 15000.
const cherry: LenderPrequalOffer = {
  lender_slug: 'cherry', lender_name: 'Cherry', decision: 'approved',
  approved_amount: 15000,
  terms: [
    { apr: 0, term_months: 12, promo_period_months: 12 },
    { apr: 9.99, term_months: 24, promo_period_months: 0 },
  ],
}
// Proceed: 9.9%/60 OR 12.9%/84. Approved 20000 (the largest — should stack first).
const proceed: LenderPrequalOffer = {
  lender_slug: 'proceed', lender_name: 'Proceed Finance', decision: 'approved',
  approved_amount: 20000,
  terms: [
    { apr: 9.9, term_months: 60, promo_period_months: 0 },
    { apr: 12.9, term_months: 84, promo_period_months: 0 },
  ],
}
// CareCredit: 0%/18 OR 14.9%/24. Approved 10000.
const carecredit: LenderPrequalOffer = {
  lender_slug: 'carecredit', lender_name: 'CareCredit', decision: 'approved',
  approved_amount: 10000,
  terms: [
    { apr: 0, term_months: 18, promo_period_months: 18 },
    { apr: 14.9, term_months: 24, promo_period_months: 0 },
  ],
}
const declined: LenderPrequalOffer = {
  lender_slug: 'affirm', lender_name: 'Affirm', decision: 'declined',
  approved_amount: 0, terms: [],
}

describe('orderOffersForStrategy', () => {
  it('maximize_coverage: highest approved amount first (interest is only a tiebreaker)', () => {
    const ordered = orderOffersForStrategy([carecredit, cherry, proceed], 'maximize_coverage')
    expect(ordered.map(o => o.lender_slug)).toEqual(['proceed', 'cherry', 'carecredit'])
  })

  it('minimize_apr: cheapest money first (promo lenders first, larger approval breaks ties)', () => {
    // cherry & carecredit both have a promo term (effective APR -1); cherry is
    // larger so it wins the tie. proceed (min 9.9%) comes last.
    const ordered = orderOffersForStrategy([carecredit, proceed, cherry], 'minimize_apr')
    expect(ordered.map(o => o.lender_slug)).toEqual(['cherry', 'carecredit', 'proceed'])
  })
})

describe('allocateCoverage', () => {
  it('stacks lenders highest-amount-first to fully cover a $45k treatment', () => {
    const plan = allocateCoverage(45000, [carecredit, cherry, proceed], 'maximize_coverage')
    expect(plan.lines).toHaveLength(3)
    expect(plan.lines[0].lender_slug).toBe('proceed') // largest approval on top
    expect(plan.total_loan).toBe(45000)
    expect(plan.gap).toBe(0)
    // each line defaults to its lowest-monthly term (proceed's is the 84mo option)
    expect(plan.lines[0].term_months).toBe(84)
    expect(plan.total_monthly).toBeCloseTo(
      plan.lines.reduce((s, l) => s + l.monthly_payment, 0), 2,
    )
  })

  it('uses a single lender when one approval covers the whole total', () => {
    const plan = allocateCoverage(12000, [proceed], 'maximize_coverage')
    expect(plan.lines).toHaveLength(1)
    expect(plan.lines[0].amount).toBe(12000) // partial draw of the 20000 approval
    expect(plan.gap).toBe(0)
  })

  it('reports the remaining gap when approvals fall short of the total', () => {
    const plan = allocateCoverage(45000, [cherry, carecredit], 'maximize_coverage')
    expect(plan.total_loan).toBe(25000) // 15000 + 10000
    expect(plan.gap).toBe(20000)
  })

  it('ignores declined offers', () => {
    const plan = allocateCoverage(10000, [declined, cherry], 'maximize_coverage')
    expect(plan.lines).toHaveLength(1)
    expect(plan.lines[0].lender_slug).toBe('cherry')
    expect(plan.lines[0].amount).toBe(10000)
  })

  it('returns an empty plan with a full gap when there are no approved offers', () => {
    const plan = allocateCoverage(30000, [declined], 'maximize_coverage')
    expect(plan.lines).toHaveLength(0)
    expect(plan.total_loan).toBe(0)
    expect(plan.total_monthly).toBe(0)
    expect(plan.gap).toBe(30000)
  })
})
