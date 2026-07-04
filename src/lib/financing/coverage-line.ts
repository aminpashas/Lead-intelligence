import { generateAmortizationSchedule } from './calculator'
import type { LenderPrequalOffer, CoverageLine } from './prequal-types'

/**
 * Turn a lender offer + an allocated principal into a CoverageLine.
 * Reuses the existing amortization engine so monthly-payment math stays
 * consistent with the rest of the financing calculator (DRY).
 */
export function buildCoverageLine(offer: LenderPrequalOffer, amount: number): CoverageLine {
  const rounded = Math.round(amount * 100) / 100
  const schedule = generateAmortizationSchedule(
    rounded,
    offer.apr,
    offer.term_months,
    offer.promo_period_months,
  )
  const monthly = schedule[0]?.payment ?? 0

  return {
    lender_slug: offer.lender_slug,
    lender_name: offer.lender_name,
    amount: rounded,
    apr: offer.apr,
    term_months: offer.term_months,
    promo_period_months: offer.promo_period_months,
    monthly_payment: Math.round(monthly * 100) / 100,
    is_promo: offer.promo_period_months > 0 || offer.apr === 0,
  }
}
