import type { LenderSlug } from './types'

// How the allocator prioritizes lenders when stacking to cover a total.
export type StackingStrategy = 'minimize_apr' | 'minimize_lenders' | 'maximize_certainty'

// One lender's soft-pull prequalification result (produced by the collect-all
// engine in Plan 2; defined here because the pure math consumes it).
export type LenderPrequalOffer = {
  lender_slug: LenderSlug
  lender_name: string
  decision: 'approved' | 'declined'
  approved_amount: number       // max this lender will fund; 0 when declined
  apr: number                   // annual percentage rate, e.g. 9.9
  term_months: number
  promo_period_months: number   // 0 when no promo
}

// A single lender's contribution to covering the treatment total.
export type CoverageLine = {
  lender_slug: LenderSlug
  lender_name: string
  amount: number                // allocated principal from this lender
  apr: number
  term_months: number
  promo_period_months: number
  monthly_payment: number       // monthly payment for `amount`
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

// A user/staff selection of one lender + how much to draw from it.
export type LenderSelection = {
  offer: LenderPrequalOffer
  amount: number                // requested amount (will be clamped to approved_amount)
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
