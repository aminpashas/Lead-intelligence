/**
 * Lender Credit Profiles & Credit-Aware Waterfall Ordering
 *
 * Each lender has a distinct credit risk appetite. Sending a subprime patient
 * to CareCredit first wastes a waterfall slot — CareCredit needs ~640+ FICO.
 * Sunbit and Cherry accept down to ~550 with high approval rates.
 *
 * This module provides:
 * 1. LENDER_CREDIT_PROFILES — authoritative per-lender credit intelligence
 * 2. buildOptimalWaterfallOrder() — reorders lenders based on estimated credit tier
 *
 * Waterfall strategy:
 * - Prime (700+):    Best rates first → CareCredit, Affirm, Alpheon, Sunbit, Cherry
 * - Good (670-699):  CareCredit, Sunbit, Affirm, Alpheon, Cherry
 * - Fair (580-669):  Sunbit, Cherry, Alpheon, Affirm, CareCredit (as last shot)
 * - Poor (<580):     Sunbit, Cherry, Alpheon (only realistic options)
 * - Unknown:         Sunbit first (highest raw approval rate), then others
 *
 * Sources: lender merchant documentation, dental industry benchmarks, partner data.
 */

import type { LenderSlug } from './types'
import type { CreditTier } from '@/lib/enrichment/credit-prequal'

// ── Lender Credit Intelligence ──────────────────────────────────────────────

export type LenderCreditProfile = {
  slug: LenderSlug
  displayName: string

  /** Estimated minimum FICO for any approval (hard floor) */
  minFicoHardFloor: number

  /** FICO score where approval rate exceeds 70% */
  minFicoForGoodApproval: number

  /** Approval rates by credit tier (0–100) */
  approvalRates: Record<CreditTier, number>

  /** Maximum financed amount */
  maxAmount: number

  /** Minimum financed amount (some lenders won't do under $1k) */
  minAmount: number

  /** Whether lender runs soft or hard credit pull */
  creditPullType: 'soft' | 'hard' | 'alternative'

  /** Whether promotional 0% APR is available */
  hasPromo: boolean

  /** Promo period in months (if applicable) */
  promoPeriodMonths: number | null

  /** Standard APR range when promo is not applicable */
  aprRange: { min: number; max: number }

  /** Is this lender specialized for dental/healthcare? */
  dentalSpecialty: boolean

  /** Priority rank within each credit tier (1 = try first) */
  tierPriority: Record<CreditTier, number>
}

/**
 * Authoritative lender credit profiles based on merchant documentation
 * and dental industry benchmarks.
 *
 * CREDIT TIER THRESHOLDS (for reference):
 *   excellent: 750–850 FICO
 *   good:      670–749 FICO
 *   fair:      580–669 FICO
 *   poor:      300–579 FICO
 */
export const LENDER_CREDIT_PROFILES: Record<LenderSlug, LenderCreditProfile> = {

  carecredit: {
    slug: 'carecredit',
    displayName: 'CareCredit',
    // CareCredit (Synchrony) targets prime borrowers. The Quickscreen pre-qual
    // has a practical floor around 620, but approval rates drop sharply below 640.
    // Above 700+ is the sweet spot for promotional terms.
    minFicoHardFloor: 620,
    minFicoForGoodApproval: 680,
    approvalRates: {
      excellent: 95,  // 750+: ~95% approval, 0% promo likely
      good:      72,  // 670–749: solid approval, may get promo or standard rate
      fair:      32,  // 580–669: hit or miss, often denied on larger amounts
      poor:       8,  // <580: rarely approved, not worth trying first
      unknown:   50,  // No data: coinflip
    },
    maxAmount: 65000,
    minAmount: 200,
    creditPullType: 'soft',
    hasPromo: true,
    promoPeriodMonths: 24,   // up to 24 months 0% depending on merchant tier
    aprRange: { min: 14.90, max: 29.99 },
    dentalSpecialty: true,
    // Priority within tier: try CareCredit first for prime (best rates),
    // last for poor (near-zero chance, wastes attempt)
    tierPriority: {
      excellent: 1,  // Best rates, highest approval → try first
      good:      1,  // Still strong choice
      fair:      4,  // Low approval rate → try after subprime specialists
      poor:      5,  // Don't try until everything else fails
      unknown:   3,
    },
  },

  sunbit: {
    slug: 'sunbit',
    displayName: 'Sunbit',
    // Sunbit uses alternative data (employment, banking, identity) rather than
    // pure FICO, which is why they claim ~90% approval. They accept subprime
    // borrowers that CareCredit and LendingClub would reject outright.
    // Specialized for point-of-sale dental/medical.
    minFicoHardFloor: 520,   // They've approved patients with 520 FICO
    minFicoForGoodApproval: 580,
    approvalRates: {
      excellent: 97,  // Near-certain approval, best terms
      good:      93,  // Excellent approval
      fair:      82,  // Strong approval — this is their specialty
      poor:      65,  // Still meaningfully better than alternatives
      unknown:   85,  // High baseline approval rate
    },
    maxAmount: 35000,
    minAmount: 500,
    creditPullType: 'soft',
    hasPromo: true,
    promoPeriodMonths: 6,
    aprRange: { min: 0, max: 35.99 },
    dentalSpecialty: true,
    tierPriority: {
      excellent: 3,  // Good but CareCredit/Affirm have better rates for prime
      good:      2,  // Strong option for good credit
      fair:      1,  // Best choice for fair credit — highest approval, dental specialist
      poor:      1,  // Best first try for poor credit
      unknown:   1,  // Highest raw approval rate → best default first attempt
    },
  },

  affirm: {
    slug: 'affirm',
    displayName: 'Affirm',
    // Affirm is BNPL-focused. Healthcare is not their core vertical, so approval
    // rates for dental are lower than Sunbit/Cherry in subprime. Strong for prime
    // borrowers who want transparent fixed terms and 0% promos.
    minFicoHardFloor: 600,
    minFicoForGoodApproval: 650,
    approvalRates: {
      excellent: 90,  // Strong approval with 0% promo options
      good:      68,  // Good approval, competitive rates
      fair:      42,  // Moderate — not their specialty
      poor:      15,  // Low approval for poor credit
      unknown:   52,
    },
    maxAmount: 50000,
    minAmount: 50,
    creditPullType: 'soft',
    hasPromo: true,
    promoPeriodMonths: 6,
    aprRange: { min: 0, max: 36 },
    dentalSpecialty: false,
    tierPriority: {
      excellent: 2,  // Good rates, transparent terms — second for prime
      good:      3,  // Reasonable option after CareCredit and Sunbit
      fair:      3,  // Below Sunbit and Cherry for fair credit
      poor:      4,  // Low approval — try after dental specialists
      unknown:   2,
    },
  },

  cherry: {
    slug: 'cherry',
    displayName: 'Cherry',
    // Cherry is purpose-built for dental and aesthetic practices.
    // They accept lower FICO than CareCredit with ~80% approval rate.
    // Known as the "second chance" lender after CareCredit denials in dental.
    minFicoHardFloor: 550,
    minFicoForGoodApproval: 600,
    approvalRates: {
      excellent: 93,  // High approval, competitive terms
      good:      80,  // Strong — this is their target market
      fair:      72,  // Excellent for fair credit — dental specialty
      poor:      45,  // Better than average for poor credit
      unknown:   70,  // High baseline
    },
    maxAmount: 50000,
    minAmount: 200,
    creditPullType: 'soft',
    hasPromo: true,
    promoPeriodMonths: 12,
    aprRange: { min: 0, max: 39.99 },
    dentalSpecialty: true,
    tierPriority: {
      excellent: 4,  // Good choice but better rates available above
      good:      4,  // Backup after primary API lenders
      fair:      2,  // Second best for fair credit after Sunbit
      poor:      2,  // Strong second choice for poor credit
      unknown:   4,
    },
  },

  alpheon: {
    slug: 'alpheon',
    displayName: 'Alpheon Credit',
    // Alpheon (formerly Alphaeon) targets elective/cosmetic procedures.
    // Highest max amount at $100K. Fixed rates from 4.99%.
    // Accepts slightly lower credit than CareCredit but above Cherry.
    // Best for large All-on-4 / full arch cases.
    minFicoHardFloor: 580,
    minFicoForGoodApproval: 640,
    approvalRates: {
      excellent: 88,  // Strong approval, very competitive fixed rates
      good:      65,  // Good, especially for larger amounts
      fair:      40,  // Below Sunbit/Cherry for fair credit
      poor:      18,  // Touch better than CareCredit for poor
      unknown:   52,
    },
    maxAmount: 100000,
    minAmount: 1000,
    creditPullType: 'soft',
    hasPromo: false,   // No promotional periods — fixed rate from day 1
    promoPeriodMonths: null,
    aprRange: { min: 4.99, max: 24.99 },
    dentalSpecialty: true,
    tierPriority: {
      excellent: 5,  // Great rates but other API lenders tried first
      good:      5,  // Good for large amounts, backup option
      fair:      5,  // Below Sunbit and Cherry for fair
      poor:      3,  // Mid-tier option for poor — better than CareCredit
      unknown:   5,
    },
  },

  proceed: {
    slug: 'proceed',
    displayName: 'Proceed Finance',
    // Proceed is a multi-lender network — submits to several lenders at once.
    // Great for high amounts and broadest coverage, but link-only integration.
    minFicoHardFloor: 580,
    minFicoForGoodApproval: 620,
    approvalRates: {
      excellent: 90,
      good:      72,
      fair:      52,
      poor:      28,
      unknown:   58,
    },
    maxAmount: 200000,
    minAmount: 1000,
    creditPullType: 'soft',
    hasPromo: false,
    promoPeriodMonths: null,
    aprRange: { min: 4.99, max: 35.99 },
    dentalSpecialty: true,
    tierPriority: {
      excellent: 6,
      good:      6,
      fair:      6,
      poor:      6,
      unknown:   6,
    },
  },

  lendingclub: {
    slug: 'lendingclub',
    displayName: 'LendingClub',
    // LendingClub Patient Solutions requires good credit — higher floor than
    // most dental lenders. Best for large fixed-rate installment loans.
    minFicoHardFloor: 640,
    minFicoForGoodApproval: 700,
    approvalRates: {
      excellent: 85,
      good:      60,  // Decent but requires solid credit
      fair:      22,  // Not their market
      poor:       5,  // Essentially no approval below 580
      unknown:   42,
    },
    maxAmount: 65000,
    minAmount: 1000,
    creditPullType: 'hard',   // LendingClub does a hard pull on full application
    hasPromo: false,
    promoPeriodMonths: null,
    aprRange: { min: 8.98, max: 35.99 },
    dentalSpecialty: false,
    tierPriority: {
      excellent: 7,
      good:      7,
      fair:      7,
      poor:      7,
      unknown:   7,
    },
  },
}

// ── Optimal Waterfall Builder ────────────────────────────────────────────────

/**
 * Build an optimally ordered list of lender slugs for a given credit tier.
 *
 * Logic:
 * 1. Filter to only lenders that are active and have a realistic approval chance
 *    (above the hard floor for this credit tier).
 * 2. Sort by tierPriority (ascending = try first).
 * 3. Within the same priority, sort by approval rate (descending).
 * 4. Link-only lenders (no submitApplication) are pushed to the back since
 *    they don't block the waterfall.
 *
 * @param activeSlugs  Lender slugs enabled for this organization
 * @param creditTier   Estimated credit tier from enrichment pipeline
 * @returns Ordered slugs — send to waterfall in this order
 */
export function buildOptimalWaterfallOrder(
  activeSlugs: LenderSlug[],
  creditTier: CreditTier
): LenderSlug[] {
  // Minimum approval rate to bother trying (below this, skip to save attempts)
  const MIN_APPROVAL_RATE_TO_INCLUDE = creditTier === 'poor' ? 20 : 30

  const ranked = activeSlugs
    .map(slug => {
      const profile = LENDER_CREDIT_PROFILES[slug]
      if (!profile) return null

      const approvalRate = profile.approvalRates[creditTier]
      const priority = profile.tierPriority[creditTier]

      return { slug, approvalRate, priority }
    })
    .filter((entry): entry is NonNullable<typeof entry> => {
      if (!entry) return false
      // Skip lenders with effectively no chance for this credit tier
      return entry.approvalRate >= MIN_APPROVAL_RATE_TO_INCLUDE
    })
    .sort((a, b) => {
      // Primary: tier priority (1 = first)
      if (a.priority !== b.priority) return a.priority - b.priority
      // Secondary: approval rate (higher = first)
      return b.approvalRate - a.approvalRate
    })

  return ranked.map(r => r.slug)
}

/**
 * Get a human-readable explanation of why a specific credit tier
 * should use the given waterfall order.
 */
export function describeWaterfallStrategy(
  orderedSlugs: LenderSlug[],
  creditTier: CreditTier
): string {
  if (orderedSlugs.length === 0) return 'No suitable lenders for this credit profile.'

  const tierLabel: Record<CreditTier, string> = {
    excellent: 'Prime (750+)',
    good:      'Good (670–749)',
    fair:      'Fair (580–669)',
    poor:      'Poor (<580)',
    unknown:   'Unknown credit',
  }

  const profiles = orderedSlugs.map(slug => {
    const p = LENDER_CREDIT_PROFILES[slug]
    const rate = p?.approvalRates[creditTier] ?? 0
    return `${p?.displayName} (~${rate}%)`
  })

  return `${tierLabel[creditTier]}: trying ${profiles.join(' → ')}`
}
