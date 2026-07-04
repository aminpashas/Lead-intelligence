import type {
  LenderAdapter, LenderConfig, LenderCredentials, LeadBasicInfo, PaymentEstimate, LenderSlug,
} from '../types'

/**
 * AGGREGATOR ADAPTER SCAFFOLD (contract-gated — not yet wired into the registry).
 *
 * The decided integration strategy is "aggregator-first hybrid": one aggregator
 * (Versatile Credit / ChargeAfter / FinMkt) fronts 30+ lenders prime→subprime
 * through a single integration, so the stacking/coverage UX can consume many
 * lenders' offers via one seam. This factory produces a link/portal-based
 * `LenderAdapter` for such an aggregator, driven entirely by `config`.
 *
 * WHY IT IS NOT YET REGISTERED in `adapters/index.ts` (`LENDER_ADAPTERS`):
 * registering requires adding a new value to `LenderSlug` and providing entries
 * in `LENDER_RATES` (rates.ts) and `LENDER_CREDIT_PROFILES` (lender-profiles.ts)
 * — those need REAL terms/approval curves from the signed aggregator, not
 * invented numbers. Wire this up when a partner contract + API credentials exist:
 *   1. add the aggregator's slug to `LenderSlug`,
 *   2. add its rate + credit-profile entries,
 *   3. register `createAggregatorAdapter(slug, name)` in `LENDER_ADAPTERS` and
 *      add `LENDER_INFO`,
 *   4. implement `preQualify` against the aggregator's real API (it waterfalls
 *      internally and returns the winning offer / a set of offers).
 *
 * Until then it is link-based: dispatch the aggregator's hosted waterfall URL to
 * the patient and reconcile via the checkout state machine (staff/patient).
 */
export function createAggregatorAdapter(slug: LenderSlug, displayName: string): LenderAdapter {
  return {
    slug,
    displayName,
    integrationType: 'link',

    generateApplicationUrl(_leadData: LeadBasicInfo, config: LenderConfig): string {
      const url = typeof config?.hosted_url === 'string' ? config.hosted_url : ''
      if (!url) throw new Error(`aggregator ${slug}: hosted_url not configured`)
      return url
    },

    // Aggregators return real offers through their hosted flow or partner API.
    // Until that API is contracted, surface only configured indicative terms
    // (or none) so the collect-all engine records an 'estimate' offer.
    async getPaymentEstimate(
      _amount: number, config: LenderConfig, _credentials?: LenderCredentials,
    ): Promise<PaymentEstimate[]> {
      return Array.isArray(config?.indicative_estimates)
        ? (config.indicative_estimates as PaymentEstimate[])
        : []
    },

    // preQualify / submitApplication intentionally unimplemented until a partner
    // API contract exists.
  }
}
