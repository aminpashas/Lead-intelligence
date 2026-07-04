import type {
  LenderPrequalOffer, CoveragePlan, CoverageLine, StackingStrategy,
} from './prequal-types'
import { buildCoverageLine, pickAffordableTerm } from './coverage-line'

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Lowest effective APR across a lender's term options (a promo/0% term counts
 * as the cheapest). Used only as a tiebreaker in ordering.
 */
function bestEffectiveApr(offer: LenderPrequalOffer): number {
  return offer.terms.reduce((min, term) => {
    const eff = term.promo_period_months > 0 ? -1 : term.apr
    return eff < min ? eff : min
  }, Number.POSITIVE_INFINITY)
}

/**
 * Order approved offers by the chosen stacking strategy.
 *
 * maximize_coverage (default): highest approved amount first, cheaper cost as
 * tiebreaker — cover the big number with the fewest lenders (a 0% lender that
 * only covers $6k should NOT outrank a $30k approval). minimize_apr: cheapest
 * money first, larger approval as tiebreaker.
 */
export function orderOffersForStrategy(
  offers: LenderPrequalOffer[],
  strategy: StackingStrategy,
): LenderPrequalOffer[] {
  const list = [...offers]
  switch (strategy) {
    case 'minimize_apr':
      return list.sort((a, b) =>
        bestEffectiveApr(a) - bestEffectiveApr(b) ||
        b.approved_amount - a.approved_amount)
    case 'maximize_coverage':
    default:
      return list.sort((a, b) =>
        b.approved_amount - a.approved_amount ||
        bestEffectiveApr(a) - bestEffectiveApr(b))
  }
}

/**
 * Build a stacked coverage plan: combine approved lender offers, in strategy
 * order, until the treatment total is covered (or offers are exhausted). Each
 * included lender defaults to its lowest-monthly-payment term. Pure — no I/O.
 * Any shortfall is reported as `gap`.
 */
export function allocateCoverage(
  treatmentTotal: number,
  offers: LenderPrequalOffer[],
  strategy: StackingStrategy = 'maximize_coverage',
): CoveragePlan {
  const approved = offers.filter(o =>
    o.decision === 'approved' && o.approved_amount > 0 && o.terms.length > 0)
  const ordered = orderOffersForStrategy(approved, strategy)

  const lines: CoverageLine[] = []
  let remaining = treatmentTotal
  for (const offer of ordered) {
    if (remaining <= 0) break
    const amount = Math.min(offer.approved_amount, remaining)
    if (amount <= 0) continue
    const term = pickAffordableTerm(offer, amount)
    lines.push(buildCoverageLine(offer, amount, term))
    remaining = round2(remaining - amount)
  }

  const total_loan = round2(lines.reduce((s, l) => s + l.amount, 0))
  const total_monthly = round2(lines.reduce((s, l) => s + l.monthly_payment, 0))

  return {
    lines,
    treatment_total: treatmentTotal,
    total_loan,
    total_monthly,
    gap: round2(treatmentTotal - total_loan),
    strategy,
  }
}
