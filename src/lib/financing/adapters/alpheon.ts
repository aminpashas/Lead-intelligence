import type {
  LenderAdapter,
  LenderConfig,
  LeadBasicInfo,
  PaymentEstimate,
} from '../types'

/**
 * Alpheon Credit Adapter (Link-Based)
 *
 * Alpheon Credit provides patient financing for dental and healthcare.
 * Competitive fixed rates, terms up to 84 months, no prepayment penalties.
 *
 * Required config:
 * - provider_id: Alpheon provider ID
 * - portal_url: Staff portal URL
 */
export class AlpheonAdapter implements LenderAdapter {
  readonly slug = 'alpheon' as const
  readonly displayName = 'Alpheon Credit'
  readonly integrationType = 'link' as const

  generateApplicationUrl(
    leadData: LeadBasicInfo,
    config: LenderConfig
  ): string {
    const providerId = config.provider_id as string || ''
    const baseUrl = 'https://app.alpheoncredit.com/apply'
    const params = new URLSearchParams({
      provider: providerId,
      ...(leadData.first_name && { fn: leadData.first_name }),
      ...(leadData.last_name && { ln: leadData.last_name }),
      ...(leadData.email && { email: leadData.email }),
      ...(leadData.phone && { phone: leadData.phone }),
    })
    return `${baseUrl}?${params.toString()}`
  }

  async getPaymentEstimate(amount: number): Promise<PaymentEstimate[]> {
    const terms = [
      { months: 24, apr: 5.99 },
      { months: 36, apr: 7.99 },
      { months: 48, apr: 9.99 },
      { months: 60, apr: 12.99 },
      { months: 84, apr: 16.99 },
    ]

    return terms.map(term => {
      const r = term.apr / 100 / 12
      const monthly = (amount * r) / (1 - Math.pow(1 + r, -term.months))

      return {
        lender_slug: 'alpheon' as const,
        lender_name: 'Alpheon Credit',
        monthly_payment: Math.round(monthly * 100) / 100,
        financed_amount: amount,
        down_payment: 0,
        apr: term.apr,
        term_months: term.months,
      }
    })
  }
}
