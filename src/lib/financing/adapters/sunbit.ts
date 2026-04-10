import { withRetry, RETRY_CONFIGS } from '@/lib/retry'
import type {
  LenderAdapter,
  LenderApplicationRequest,
  LenderApplicationResponse,
  LenderCredentials,
  LenderConfig,
  LeadBasicInfo,
  PaymentEstimate,
} from '../types'

/**
 * Sunbit Adapter
 *
 * Integration via Sunbit Developer Portal (developers.sunbit.com):
 * - Token-based authentication (Token header)
 * - Payment Estimation API: returns payment plan options for a given amount
 * - Pre-Qualification Link API: generates a link for patient to complete pre-qual
 * - Application is completed on Sunbit's hosted platform (redirect model)
 *
 * Required credentials:
 * - api_token: Sunbit API token
 * - location_id: Sunbit merchant location ID
 *
 * Required config:
 * - api_base_url: Sunbit API base (sandbox vs production)
 */
export class SunbitAdapter implements LenderAdapter {
  readonly slug = 'sunbit' as const
  readonly displayName = 'Sunbit'
  readonly integrationType = 'api' as const

  /**
   * Sunbit doesn't support full programmatic application submission.
   * Instead, we generate a pre-qualification link and track the result
   * via webhook. This method generates the link and returns 'pending'.
   */
  async submitApplication(
    request: LenderApplicationRequest,
    credentials: LenderCredentials
  ): Promise<LenderApplicationResponse> {
    return withRetry(async () => {
      const baseUrl = credentials.api_base_url || 'https://api.sunbit.com'

      // Generate a pre-qualification link with prefilled data
      const response = await fetch(`${baseUrl}/v1/prequalification/link`, {
        method: 'POST',
        headers: {
          'Token': credentials.api_token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          locationId: credentials.location_id,
          amount: request.requested_amount,
          customer: {
            firstName: request.applicant.first_name,
            lastName: request.applicant.last_name,
            email: request.applicant.email,
            phone: request.applicant.phone,
          },
        }),
      })

      if (!response.ok) {
        const errorBody = await response.text()
        return {
          status: 'error' as const,
          external_id: null,
          error_message: `Sunbit API error ${response.status}: ${errorBody}`,
        }
      }

      const result = await response.json()

      // Sunbit returns a link — the patient must complete the application there
      return {
        status: 'pending' as const,
        external_id: result.transactionId || result.referenceId || null,
        raw_response: {
          prequalification_url: result.url || result.link,
          transaction_id: result.transactionId,
        },
      }
    }, RETRY_CONFIGS.financing)
  }

  /**
   * Check status of a pending Sunbit application.
   */
  async checkStatus(
    externalId: string,
    credentials: LenderCredentials
  ): Promise<LenderApplicationResponse> {
    const baseUrl = credentials.api_base_url || 'https://api.sunbit.com'

    const response = await fetch(`${baseUrl}/v1/transactions/${externalId}`, {
      headers: {
        'Token': credentials.api_token,
      },
    })

    if (!response.ok) {
      return {
        status: 'error',
        external_id: externalId,
        error_message: `Sunbit status check failed: ${response.status}`,
      }
    }

    const result = await response.json()
    const status = result.status?.toLowerCase()

    return {
      status: status === 'approved' ? 'approved'
        : status === 'denied' || status === 'declined' ? 'denied'
        : 'pending',
      external_id: externalId,
      approved_amount: result.approvedAmount,
      terms: result.selectedPlan ? {
        apr: result.selectedPlan.apr || 0,
        term_months: result.selectedPlan.termMonths || 0,
        monthly_payment: result.selectedPlan.monthlyPayment || 0,
      } : undefined,
      denial_reason_code: result.declineReason,
    }
  }

  /**
   * Generate a Sunbit application URL for the patient.
   */
  generateApplicationUrl(
    leadData: LeadBasicInfo,
    config: LenderConfig
  ): string {
    const locationId = config.location_id as string || ''
    return `https://sunbit.com/apply/${locationId}`
  }

  /**
   * Get payment estimates from the Sunbit Payment Estimation API.
   * This is a real API call — returns actual plan options.
   */
  async getPaymentEstimate(
    amount: number,
    config: LenderConfig,
    credentials?: LenderCredentials
  ): Promise<PaymentEstimate[]> {
    if (!credentials?.api_token) {
      // Return default estimates if no credentials configured
      return this.getDefaultEstimates(amount)
    }

    try {
      const baseUrl = (credentials.api_base_url as string) || 'https://api.sunbit.com'

      const response = await fetch(
        `${baseUrl}/purchase-service/payment-estimation?amount=${amount}&locationId=${credentials.location_id}`,
        {
          headers: { 'Token': credentials.api_token },
        }
      )

      if (!response.ok) {
        return this.getDefaultEstimates(amount)
      }

      const result = await response.json()

      if (!Array.isArray(result.plans)) {
        return this.getDefaultEstimates(amount)
      }

      return result.plans.map((plan: Record<string, number>) => ({
        lender_slug: 'sunbit' as const,
        lender_name: 'Sunbit',
        monthly_payment: plan.monthlyPayment || 0,
        financed_amount: plan.financedAmount || amount,
        down_payment: plan.downPayment || 0,
        apr: plan.apr || 0,
        term_months: plan.termMonths || 0,
      }))
    } catch {
      return this.getDefaultEstimates(amount)
    }
  }

  /**
   * Verify Sunbit webhook signature.
   */
  verifyWebhook(signature: string, body: string, secret: string): boolean {
    const crypto = require('crypto')
    const expected = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex')
    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expected, 'hex')
      )
    } catch {
      return false
    }
  }

  /**
   * Default payment estimates when API is not available.
   */
  private getDefaultEstimates(amount: number): PaymentEstimate[] {
    const terms = [
      { months: 6, apr: 0 },
      { months: 12, apr: 9.99 },
      { months: 24, apr: 9.99 },
      { months: 36, apr: 9.99 },
    ]

    return terms.map(term => {
      const monthlyRate = term.apr / 100 / 12
      const monthly = monthlyRate > 0
        ? (amount * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -term.months))
        : amount / term.months

      return {
        lender_slug: 'sunbit' as const,
        lender_name: 'Sunbit',
        monthly_payment: Math.round(monthly * 100) / 100,
        financed_amount: amount,
        down_payment: 0,
        apr: term.apr,
        term_months: term.months,
      }
    })
  }
}
