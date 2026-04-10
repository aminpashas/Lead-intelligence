import type {
  LenderAdapter,
  LenderConfig,
  LeadBasicInfo,
  PaymentEstimate,
} from '../types'

/**
 * Proceed Finance Adapter (Link-Only)
 *
 * Proceed Finance does NOT offer a public REST API.
 * Integration is limited to:
 * - Generating patient application URLs with provider office code
 * - Embedding the application page as an iframe
 * - Staff manually checking the Proceed Finance provider portal
 *
 * Required config:
 * - provider_office_code: Proceed Finance office code for this practice
 * - provider_portal_url: URL to the provider's Proceed Finance portal (for staff)
 */
export class ProceedAdapter implements LenderAdapter {
  readonly slug = 'proceed' as const
  readonly displayName = 'Proceed Finance'
  readonly integrationType = 'link' as const

  /**
   * Generate a patient-facing Proceed Finance application URL.
   * The patient completes the application on Proceed's platform.
   */
  generateApplicationUrl(
    leadData: LeadBasicInfo,
    config: LenderConfig
  ): string {
    const officeCode = config.provider_office_code as string || ''

    // Proceed Finance application URL pattern
    // The office code identifies the practice so the application is attributed correctly
    const baseUrl = 'https://app.proceedfinance.com/apply'
    const params = new URLSearchParams({
      office: officeCode,
      ...(leadData.first_name && { fn: leadData.first_name }),
      ...(leadData.last_name && { ln: leadData.last_name }),
      ...(leadData.email && { email: leadData.email }),
      ...(leadData.phone && { phone: leadData.phone }),
    })

    return `${baseUrl}?${params.toString()}`
  }

  /**
   * Get estimated payment plans.
   * Proceed Finance is a multi-lender platform so terms vary.
   * These are representative estimates based on their published ranges.
   */
  async getPaymentEstimate(
    amount: number
  ): Promise<PaymentEstimate[]> {
    // Proceed Finance offers terms from multiple lenders
    // These are representative ranges based on their marketing
    const terms = [
      { months: 24, apr: 7.99, label: 'Tier A' },
      { months: 36, apr: 9.99, label: 'Tier B' },
      { months: 48, apr: 12.99, label: 'Tier C' },
      { months: 60, apr: 14.99, label: 'Tier D' },
    ]

    return terms.map(term => {
      const monthlyRate = term.apr / 100 / 12
      const monthly = (amount * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -term.months))

      return {
        lender_slug: 'proceed' as const,
        lender_name: `Proceed Finance (${term.label})`,
        monthly_payment: Math.round(monthly * 100) / 100,
        financed_amount: amount,
        down_payment: 0,
        apr: term.apr,
        term_months: term.months,
      }
    })
  }
}
