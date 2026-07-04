import type { LenderSlug } from './types'

// How the allocator prioritizes lenders when stacking to cover a total.
// maximize_coverage (default): highest approved amount first, cheaper cost as
// tiebreaker — cover the big number with the fewest lenders. minimize_apr:
// cheapest money first.
export type StackingStrategy = 'maximize_coverage' | 'minimize_apr'

// One financing term a lender offers (lenders offer several — e.g. 0%/12mo OR
// 9.99%/24mo OR 14.9%/60mo). Each yields a different monthly payment.
export type LenderTermOption = {
  apr: number                   // annual percentage rate, e.g. 9.9 (0 for promo)
  term_months: number
  promo_period_months: number   // 0 when no promo
}

// One lender's soft-pull prequalification result (produced by the collect-all
// engine in Plan 2; defined here because the pure math consumes it).
export type LenderPrequalOffer = {
  lender_slug: LenderSlug
  lender_name: string
  decision: 'approved' | 'declined'
  approved_amount: number       // max this lender will fund; 0 when declined
  terms: LenderTermOption[]     // the term options this lender offers (empty when declined)
}

// A single lender's contribution to covering the treatment total, for a chosen term.
export type CoverageLine = {
  lender_slug: LenderSlug
  lender_name: string
  amount: number                // allocated principal from this lender
  apr: number                   // from the chosen term
  term_months: number           // from the chosen term
  promo_period_months: number   // from the chosen term
  monthly_payment: number       // monthly payment for `amount` on the chosen term
  is_promo: boolean
}

// The stacked plan: which lenders cover how much, and the blended totals.
export type CoveragePlan = {
  lines: CoverageLine[]
  treatment_total: number
  total_loan: number            // sum of line amounts (<= treatment_total)
  total_monthly: number         // sum of line monthly payments
  gap: number                   // treatment_total - total_loan (routes to cash/in-house)
  strategy: StackingStrategy
}

// A user/staff selection of one lender, how much to draw, and which term.
export type LenderSelection = {
  offer: LenderPrequalOffer
  amount: number                // requested amount (will be clamped to approved_amount)
  term: LenderTermOption        // the term the user picked for this lender
}

// Live totals for an arbitrary selection (drives the interactive UI).
export type SelectionTotals = {
  lines: CoverageLine[]
  total_loan: number
  total_monthly: number
  covered: number               // min(total_loan, treatment_total)
  gap: number                   // max(0, treatment_total - total_loan)
  selected_count: number
}
