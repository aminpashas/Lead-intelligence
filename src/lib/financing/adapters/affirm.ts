import type {
  LenderAdapter,
  LenderConfig,
  LeadBasicInfo,
  PaymentEstimate,
} from '../types'

/**
 * Affirm Adapter (Link-Based)
 *
 * Affirm offers buy-now-pay-later financing, expanding into healthcare.
 * Known for transparent terms, no hidden fees, and 0% APR promotional options.
 *
 * Required config:
 * - merchant_id: Affirm merchant ID
 * - public_api_key: Affirm public API key (for pre-qual widget)
 */
export class AffirmAdapter implements LenderAdapter {
  readonly slug = 'affirm' as const
  readonly displayName = 'Affirm'
  readonly integrationType = 'link' as const

  generateApplicationUrl(
    leadData: LeadBasicInfo,
    config: LenderConfig
  ): string {
    const merchantId = config.merchant_id as string || ''
    const baseUrl = 'https://www.affirm.com/apps/prequal'
    const params = new URLSearchParams({
      merchant_id: merchantId,
      ...(leadData.first_name && { first_name: leadData.first_name }),
      ...(leadData.last_name && { last_name: leadData.last_name }),
      ...(leadData.email && { email: leadData.email }),
    })
    return `${baseUrl}?${params.toString()}`
  }

  async getPaymentEstimate(amount: number): Promise<PaymentEstimate[]> {
    const terms = [
      { months: 3, apr: 0, promo: 3 },
      { months: 6, apr: 0, promo: 6 },
      { months: 12, apr: 10 },
      { months: 24, apr: 15 },
      { months: 36, apr: 20 },
      { months: 48, apr: 26 },
    ]

    return terms.map(term => {
      let monthly: number
      if (term.apr === 0) {
        monthly = amount / term.months
      } else {
        const r = term.apr / 100 / 12
        monthly = (amount * r) / (1 - Math.pow(1 + r, -term.months))
      }

      return {
        lender_slug: 'affirm' as const,
        lender_name: 'Affirm',
        monthly_payment: Math.round(monthly * 100) / 100,
        financed_amount: amount,
        down_payment: 0,
        apr: term.apr,
        term_months: term.months,
        ...(term.promo && { promo_period_months: term.promo }),
      }
    })
  }
}
