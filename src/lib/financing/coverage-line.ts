import { generateAmortizationSchedule } from './calculator'
import type { LenderPrequalOffer, LenderTermOption, CoverageLine } from './prequal-types'

/**
 * Monthly payment for a principal on a given term. Reuses the existing
 * amortization engine so monthly-payment math stays consistent with the rest
 * of the financing calculator (DRY).
 */
export function monthlyPaymentFor(amount: number, term: LenderTermOption): number {
  const rounded = Math.round(amount * 100) / 100
  const schedule = generateAmortizationSchedule(
    rounded,
    term.apr,
    term.term_months,
    term.promo_period_months,
  )
  return Math.round((schedule[0]?.payment ?? 0) * 100) / 100
}

/**
 * Default recommended term for a lender: the LONGEST term (lowest *required*
 * monthly payment, maximum flexibility). This is the practice's coaching rule —
 * take the longest term for a low mandatory payment, then, since these loans
 * have NO prepayment penalty, accelerate voluntarily (extra principal +
 * weekly/biweekly payments) to cut total interest. Ties on term length break to
 * the lower monthly payment. The patient can override the term per lender in the UI.
 */
export function pickAffordableTerm(offer: LenderPrequalOffer, amount: number): LenderTermOption {
  if (offer.terms.length === 0) {
    throw new Error(`lender ${offer.lender_slug} has no term options`)
  }
  return offer.terms.reduce((best, term) => {
    if (term.term_months !== best.term_months) {
      return term.term_months > best.term_months ? term : best
    }
    return monthlyPaymentFor(amount, term) < monthlyPaymentFor(amount, best) ? term : best
  })
}

/**
 * Turn a lender offer + an allocated principal + a chosen term into a CoverageLine.
 */
export function buildCoverageLine(
  offer: LenderPrequalOffer,
  amount: number,
  term: LenderTermOption,
): CoverageLine {
  const rounded = Math.round(amount * 100) / 100
  return {
    lender_slug: offer.lender_slug,
    lender_name: offer.lender_name,
    amount: rounded,
    apr: term.apr,
    term_months: term.term_months,
    promo_period_months: term.promo_period_months,
    monthly_payment: monthlyPaymentFor(rounded, term),
    is_promo: term.promo_period_months > 0 || term.apr === 0,
  }
}
