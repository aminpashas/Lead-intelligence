/**
 * Lender Rate Matrix
 *
 * Default rate/term configurations per lender. Used for payment
 * estimates when live API estimates aren't available.
 * These are representative rates based on published lender information.
 */

import type { LenderSlug } from './types'

export type RateTier = {
  label: string
  apr: number
  term_months: number
  promo_months?: number   // 0% APR promotional period
  min_amount?: number
  max_amount?: number
  down_payment_pct?: number
}

export type LenderRateConfig = {
  slug: LenderSlug
  name: string
  tiers: RateTier[]
  approval_rate_estimate: number  // 0-100
  min_credit_score?: number
  max_loan_amount: number
}

export const LENDER_RATES: Record<LenderSlug, LenderRateConfig> = {
  carecredit: {
    slug: 'carecredit',
    name: 'CareCredit',
    approval_rate_estimate: 60,
    min_credit_score: 620,
    max_loan_amount: 65000,
    tiers: [
      { label: 'Promo 6mo 0%', apr: 0, term_months: 6, promo_months: 6 },
      { label: 'Promo 12mo 0%', apr: 0, term_months: 12, promo_months: 12 },
      { label: 'Promo 24mo 0%', apr: 0, term_months: 24, promo_months: 24, min_amount: 1000 },
      { label: '24 months', apr: 17.9, term_months: 24 },
      { label: '36 months', apr: 17.9, term_months: 36 },
      { label: '48 months', apr: 17.9, term_months: 48, min_amount: 2500 },
      { label: '60 months', apr: 17.9, term_months: 60, min_amount: 5000 },
    ],
  },

  sunbit: {
    slug: 'sunbit',
    name: 'Sunbit',
    approval_rate_estimate: 90,
    max_loan_amount: 35000,
    tiers: [
      { label: '6 months', apr: 0, term_months: 6 },
      { label: '12 months', apr: 9.99, term_months: 12 },
      { label: '24 months', apr: 14.99, term_months: 24 },
      { label: '36 months', apr: 19.99, term_months: 36 },
      { label: '48 months', apr: 24.99, term_months: 48 },
    ],
  },

  proceed: {
    slug: 'proceed',
    name: 'Proceed Finance',
    approval_rate_estimate: 70,
    min_credit_score: 550,
    max_loan_amount: 100000,
    tiers: [
      { label: 'Tier A (Excellent)', apr: 4.99, term_months: 36 },
      { label: 'Tier A (Excellent)', apr: 5.99, term_months: 60 },
      { label: 'Tier B (Good)', apr: 9.99, term_months: 36 },
      { label: 'Tier B (Good)', apr: 11.99, term_months: 60 },
      { label: 'Tier C (Fair)', apr: 14.99, term_months: 48 },
      { label: 'Tier D (Building)', apr: 19.99, term_months: 60 },
      { label: 'Tier E (Extended)', apr: 24.99, term_months: 84 },
    ],
  },

  lendingclub: {
    slug: 'lendingclub',
    name: 'LendingClub',
    approval_rate_estimate: 55,
    min_credit_score: 600,
    max_loan_amount: 65000,
    tiers: [
      { label: '24 months', apr: 8.98, term_months: 24 },
      { label: '36 months', apr: 10.99, term_months: 36 },
      { label: '48 months', apr: 13.99, term_months: 48 },
      { label: '60 months', apr: 15.99, term_months: 60 },
      { label: '84 months', apr: 19.99, term_months: 84 },
    ],
  },

  cherry: {
    slug: 'cherry',
    name: 'Cherry',
    approval_rate_estimate: 80,
    max_loan_amount: 50000,
    tiers: [
      { label: '6 months 0%', apr: 0, term_months: 6, promo_months: 6 },
      { label: '12 months 0%', apr: 0, term_months: 12, promo_months: 12 },
      { label: '24 months', apr: 14.99, term_months: 24 },
      { label: '36 months', apr: 19.99, term_months: 36 },
      { label: '48 months', apr: 24.99, term_months: 48 },
      { label: '60 months', apr: 29.99, term_months: 60 },
    ],
  },

  alpheon: {
    slug: 'alpheon',
    name: 'Alpheon Credit',
    approval_rate_estimate: 65,
    min_credit_score: 580,
    max_loan_amount: 100000,
    tiers: [
      { label: '24 months', apr: 5.99, term_months: 24 },
      { label: '36 months', apr: 7.99, term_months: 36 },
      { label: '48 months', apr: 9.99, term_months: 48 },
      { label: '60 months', apr: 12.99, term_months: 60 },
      { label: '84 months', apr: 16.99, term_months: 84 },
    ],
  },

  affirm: {
    slug: 'affirm',
    name: 'Affirm',
    approval_rate_estimate: 70,
    max_loan_amount: 50000,
    tiers: [
      { label: '3 months 0%', apr: 0, term_months: 3, promo_months: 3 },
      { label: '6 months 0%', apr: 0, term_months: 6, promo_months: 6 },
      { label: '12 months', apr: 10, term_months: 12 },
      { label: '24 months', apr: 15, term_months: 24 },
      { label: '36 months', apr: 20, term_months: 36 },
      { label: '48 months', apr: 26, term_months: 48 },
    ],
  },
}

/**
 * Get applicable rate tiers for a given amount and lender.
 */
export function getApplicableTiers(slug: LenderSlug, amount: number): RateTier[] {
  const config = LENDER_RATES[slug]
  if (!config) return []

  return config.tiers.filter(tier => {
    if (amount > config.max_loan_amount) return false
    if (tier.min_amount && amount < tier.min_amount) return false
    if (tier.max_amount && amount > tier.max_amount) return false
    return true
  })
}
