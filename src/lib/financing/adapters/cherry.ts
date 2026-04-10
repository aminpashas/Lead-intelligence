import type {
  LenderAdapter,
  LenderConfig,
  LeadBasicInfo,
  PaymentEstimate,
} from '../types'

/**
 * Cherry Adapter (Link-Based)
 *
 * Cherry offers point-of-sale patient financing for dental practices.
 * High approval rates, promotional 0% terms, simple application.
 *
 * Required config:
 * - practice_id: Cherry practice ID
 * - portal_url: Staff portal URL
 */
export class CherryAdapter implements LenderAdapter {
  readonly slug = 'cherry' as const
  readonly displayName = 'Cherry'
  readonly integrationType = 'link' as const

  generateApplicationUrl(
    leadData: LeadBasicInfo,
    config: LenderConfig
  ): string {
    const practiceId = config.practice_id as string || ''
    const baseUrl = 'https://patient.withcherry.com/apply'
    const params = new URLSearchParams({
      practice: practiceId,
      ...(leadData.first_name && { first_name: leadData.first_name }),
      ...(leadData.last_name && { last_name: leadData.last_name }),
      ...(leadData.email && { email: leadData.email }),
      ...(leadData.phone && { phone: leadData.phone }),
    })
    return `${baseUrl}?${params.toString()}`
  }

  async getPaymentEstimate(amount: number): Promise<PaymentEstimate[]> {
    const terms = [
      { months: 6, apr: 0, promo: 6 },
      { months: 12, apr: 0, promo: 12 },
      { months: 24, apr: 14.99 },
      { months: 36, apr: 19.99 },
      { months: 48, apr: 24.99 },
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
        lender_slug: 'cherry' as const,
        lender_name: 'Cherry',
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
