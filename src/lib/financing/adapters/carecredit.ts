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
 * CareCredit (Synchrony) Adapter
 *
 * Integration via Synchrony Developer Portal (developer.syf.com):
 * - OAuth 2.0 authentication
 * - Quickscreen API: soft credit pull pre-qualification
 * - Consumer Self Service (CSS): prefilled application link generation
 * - Credit Authorizations API: transaction processing
 * - Webhook reconciliation for status updates
 *
 * Required credentials:
 * - client_id: OAuth client ID from Synchrony partner portal
 * - client_secret: OAuth client secret
 * - merchant_id: CareCredit merchant number
 * - partner_code: Technology partner code
 *
 * Required config:
 * - api_base_url: Synchrony API base (sandbox vs production)
 * - promo_codes: Array of available promotional financing terms
 */
export class CareCreditAdapter implements LenderAdapter {
  readonly slug = 'carecredit' as const
  readonly displayName = 'CareCredit'
  readonly integrationType = 'api' as const

  /**
   * Submit a full financing application via Synchrony's API.
   * Uses Quickscreen for pre-qualification (soft pull), then
   * generates a CSS application link if pre-qualified.
   */
  async submitApplication(
    request: LenderApplicationRequest,
    credentials: LenderCredentials
  ): Promise<LenderApplicationResponse> {
    return withRetry(async () => {
      const baseUrl = credentials.api_base_url || 'https://api.syf.com'
      const token = await this.getOAuthToken(credentials)

      // Step 1: Quickscreen pre-qualification (soft pull)
      const prequalResponse = await fetch(`${baseUrl}/v1/quickscreen`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Merchant-Id': credentials.merchant_id,
        },
        body: JSON.stringify({
          firstName: request.applicant.first_name,
          lastName: request.applicant.last_name,
          addressLine1: request.applicant.address.street,
          city: request.applicant.address.city,
          state: request.applicant.address.state,
          zipCode: request.applicant.address.zip,
          ssn: request.applicant.ssn,
          dateOfBirth: request.applicant.date_of_birth,
          requestedAmount: request.requested_amount,
        }),
      })

      if (!prequalResponse.ok) {
        const errorBody = await prequalResponse.text()
        return {
          status: 'error' as const,
          external_id: null,
          error_message: `CareCredit API error ${prequalResponse.status}: ${errorBody}`,
        }
      }

      const result = await prequalResponse.json()

      if (result.decision === 'APPROVED' || result.decision === 'PREAPPROVED') {
        return {
          status: 'approved',
          external_id: result.applicationId || result.referenceId || null,
          approved_amount: result.approvedAmount || result.creditLimit,
          terms: result.terms ? {
            apr: result.terms.apr,
            term_months: result.terms.termMonths,
            monthly_payment: result.terms.monthlyPayment,
            promo_period_months: result.terms.promoMonths,
          } : undefined,
        }
      }

      if (result.decision === 'DECLINED' || result.decision === 'DENIED') {
        return {
          status: 'denied',
          external_id: result.applicationId || null,
          denial_reason_code: result.reasonCode || result.declineReason,
        }
      }

      // Pending — async decision
      return {
        status: 'pending',
        external_id: result.applicationId || result.referenceId || null,
      }
    }, RETRY_CONFIGS.financing)
  }

  /**
   * Check status of a pending application.
   */
  async checkStatus(
    externalId: string,
    credentials: LenderCredentials
  ): Promise<LenderApplicationResponse> {
    const baseUrl = credentials.api_base_url || 'https://api.syf.com'
    const token = await this.getOAuthToken(credentials)

    const response = await fetch(`${baseUrl}/v1/applications/${externalId}/status`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Merchant-Id': credentials.merchant_id,
      },
    })

    if (!response.ok) {
      return {
        status: 'error',
        external_id: externalId,
        error_message: `Status check failed: ${response.status}`,
      }
    }

    const result = await response.json()

    return {
      status: result.decision === 'APPROVED' ? 'approved'
        : result.decision === 'DENIED' ? 'denied'
        : 'pending',
      external_id: externalId,
      approved_amount: result.approvedAmount,
      terms: result.terms ? {
        apr: result.terms.apr,
        term_months: result.terms.termMonths,
        monthly_payment: result.terms.monthlyPayment,
        promo_period_months: result.terms.promoMonths,
      } : undefined,
      denial_reason_code: result.reasonCode,
    }
  }

  /**
   * Generate a CareCredit patient application URL via CSS.
   */
  generateApplicationUrl(
    leadData: LeadBasicInfo,
    config: LenderConfig
  ): string {
    const merchantId = config.merchant_id as string || ''
    const baseUrl = 'https://www.carecredit.com/apply'
    const params = new URLSearchParams({
      sitecode: merchantId,
      ...(leadData.first_name && { fname: leadData.first_name }),
      ...(leadData.last_name && { lname: leadData.last_name }),
    })
    return `${baseUrl}?${params.toString()}`
  }

  /**
   * Get payment estimates for a given amount.
   */
  async getPaymentEstimate(
    amount: number,
    config: LenderConfig
  ): Promise<PaymentEstimate[]> {
    // CareCredit standard promotional terms
    const promoTerms = [
      { months: 12, apr: 0, promoMonths: 12 },
      { months: 24, apr: 14.9, promoMonths: 6 },
      { months: 36, apr: 14.9, promoMonths: 6 },
      { months: 48, apr: 14.9, promoMonths: 6 },
      { months: 60, apr: 14.9, promoMonths: 6 },
    ]

    return promoTerms.map(term => {
      const monthlyRate = term.apr / 100 / 12
      const monthly = monthlyRate > 0
        ? (amount * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -term.months))
        : amount / term.months

      return {
        lender_slug: 'carecredit' as const,
        lender_name: 'CareCredit',
        monthly_payment: Math.round(monthly * 100) / 100,
        financed_amount: amount,
        down_payment: 0,
        apr: term.apr,
        term_months: term.months,
        promo_period_months: term.promoMonths,
      }
    })
  }

  /**
   * Verify CareCredit webhook signature (HMAC-SHA256).
   */
  verifyWebhook(signature: string, body: string, secret: string): boolean {
    const crypto = require('crypto')
    const expected = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex')
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')
    )
  }

  /**
   * Get OAuth token from Synchrony.
   */
  private async getOAuthToken(credentials: LenderCredentials): Promise<string> {
    const baseUrl = credentials.api_base_url || 'https://api.syf.com'
    const response = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
      }),
    })

    if (!response.ok) {
      throw new Error(`CareCredit OAuth failed: ${response.status}`)
    }

    const data = await response.json()
    return data.access_token
  }
}
