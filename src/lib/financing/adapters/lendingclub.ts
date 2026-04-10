import type {
  LenderAdapter,
  LenderConfig,
  LeadBasicInfo,
  PaymentEstimate,
} from '../types'

/**
 * LendingClub Patient Solutions Adapter (Link-Only)
 *
 * LendingClub Patient Solutions does NOT offer a public API for patient financing.
 * (Their developer portal at lendingclub.com/developers is for the investor marketplace only.)
 *
 * Integration is limited to:
 * - Generating patient application URLs
 * - Embedding the payment calculator
 * - Staff manually checking the LendingClub provider portal
 *
 * Note: LendingClub Patient Solutions accounts are now managed through
 * Comenity/NBT Bank, indicating the product has been restructured.
 *
 * Required config:
 * - provider_id: LendingClub provider enrollment ID
 * - provider_portal_url: URL to the provider's LCPS portal (for staff)
 */
export class LendingClubAdapter implements LenderAdapter {
  readonly slug = 'lendingclub' as const
  readonly displayName = 'LendingClub'
  readonly integrationType = 'link' as const

  /**
   * Generate a patient-facing LendingClub application URL.
   */
  generateApplicationUrl(
    leadData: LeadBasicInfo,
    config: LenderConfig
  ): string {
    const providerId = config.provider_id as string || ''
    const baseUrl = 'https://www.lendingclub.com/patientsolutions/app/search'
    const params = new URLSearchParams({
      provider: providerId,
      ...(leadData.first_name && { firstName: leadData.first_name }),
      ...(leadData.last_name && { lastName: leadData.last_name }),
    })

    return `${baseUrl}?${params.toString()}`
  }

  /**
   * Get estimated payment plans.
   * LendingClub Patient Solutions offers fixed-rate installment loans.
   */
  async getPaymentEstimate(
    amount: number
  ): Promise<PaymentEstimate[]> {
    // LendingClub Patient Solutions typical terms
    const terms = [
      { months: 24, apr: 4.99 },
      { months: 36, apr: 7.99 },
      { months: 48, apr: 9.99 },
      { months: 60, apr: 12.99 },
      { months: 84, apr: 14.99 },
    ]

    return terms.map(term => {
      const monthlyRate = term.apr / 100 / 12
      const monthly = (amount * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -term.months))

      return {
        lender_slug: 'lendingclub' as const,
        lender_name: 'LendingClub',
        monthly_payment: Math.round(monthly * 100) / 100,
        financed_amount: amount,
        down_payment: 0,
        apr: term.apr,
        term_months: term.months,
      }
    })
  }
}
