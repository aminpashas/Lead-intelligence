import { describe, it, expect } from 'vitest'
import { computeSelectionTotals } from '@/lib/financing/selection-totals'
import type { LenderPrequalOffer, LenderTermOption } from '@/lib/financing/prequal-types'

const cherryPromo: LenderTermOption = { apr: 0, term_months: 12, promo_period_months: 12 }
const proceedTerm: LenderTermOption = { apr: 9.9, term_months: 60, promo_period_months: 0 }

const cherry: LenderPrequalOffer = {
  lender_slug: 'cherry', lender_name: 'Cherry', decision: 'approved',
  approved_amount: 15000, terms: [cherryPromo],
}
const proceed: LenderPrequalOffer = {
  lender_slug: 'proceed', lender_name: 'Proceed Finance', decision: 'approved',
  approved_amount: 20000, terms: [proceedTerm],
}

describe('computeSelectionTotals', () => {
  it('sums selected loan amounts and monthly payments for the chosen terms', () => {
    const totals = computeSelectionTotals(
      [
        { offer: cherry, amount: 15000, term: cherryPromo },
        { offer: proceed, amount: 20000, term: proceedTerm },
      ],
      45000,
    )
    expect(totals.selected_count).toBe(2)
    expect(totals.total_loan).toBe(35000)
    expect(totals.covered).toBe(35000)
    expect(totals.gap).toBe(10000)
    expect(totals.total_monthly).toBeCloseTo(
      totals.lines.reduce((s, l) => s + l.monthly_payment, 0), 2,
    )
  })

  it('clamps a requested amount to the lender approved cap', () => {
    const totals = computeSelectionTotals(
      [{ offer: cherry, amount: 99999, term: cherryPromo }], 45000,
    )
    expect(totals.total_loan).toBe(15000) // clamped to approved 15000
    expect(totals.lines[0].amount).toBe(15000)
  })

  it('never reports negative gap when selection exceeds the treatment total', () => {
    const totals = computeSelectionTotals(
      [
        { offer: cherry, amount: 15000, term: cherryPromo },
        { offer: proceed, amount: 20000, term: proceedTerm },
      ],
      30000,
    )
    expect(totals.total_loan).toBe(35000)
    expect(totals.covered).toBe(30000) // capped at treatment total
    expect(totals.gap).toBe(0)
  })

  it('returns zeros for an empty selection', () => {
    const totals = computeSelectionTotals([], 30000)
    expect(totals.selected_count).toBe(0)
    expect(totals.total_loan).toBe(0)
    expect(totals.total_monthly).toBe(0)
    expect(totals.gap).toBe(30000)
  })
})
