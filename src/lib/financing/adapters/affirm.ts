import { withRetry, RETRY_CONFIGS } from '@/lib/retry'
import type {
  LenderAdapter,
  LenderApplicationRequest,
  LenderApplicationResponse,
  LenderCredentials,
  LenderConfig,
  PaymentEstimate,
} from '../types'

/**
 * Affirm Adapter (API-Based)
 *
 * Integration via Affirm Checkout API:
 * - Key-pair authentication (public_key + private_key via HTTP Basic Auth)
 * - POST /api/v1/checkout → creates a checkout session, returns checkout_token
 * - Patient completes application on Affirm's hosted checkout page
 * - Result delivered via webhook (event: charge.confirmed / charge.rejected)
 * - GET /api/v1/transactions/{charge_id} → status polling
 *
 * Affirm returns amounts in cents (USD × 100).
 *
 * Required credentials:
 * - public_key:  Affirm public API key
 * - private_key: Affirm private API key
 * - api_base_url: https://api.affirm.com (prod) or https://sandbox.affirm.com (sandbox)
 *
 * Optional config:
 * - financial_product_key: Specific healthcare product key (if issued by Affirm)
 */
export class AffirmAdapter implements LenderAdapter {
  readonly slug = 'affirm' as const
  readonly displayName = 'Affirm'
  readonly integrationType = 'api' as const

  /**
   * Create an Affirm checkout session for the patient.
   * Returns `pending` with the checkout_token as external_id.
   * The patient completes the application on Affirm's hosted page.
   * Webhook fires when they're done → waterfall resumes via resumeWaterfall().
   */
  async submitApplication(
    request: LenderApplicationRequest,
    credentials: LenderCredentials
  ): Promise<LenderApplicationResponse> {
    return withRetry(async () => {
      const baseUrl = credentials.api_base_url || 'https://api.affirm.com'

      // Affirm uses HTTP Basic Auth: public_key:private_key → base64
      const authToken = Buffer.from(
        `${credentials.public_key}:${credentials.private_key}`
      ).toString('base64')

      // Amount in cents
      const amountCents = Math.round(request.requested_amount * 100)

      const checkoutPayload: Record<string, unknown> = {
        merchant: {
          public_api_key: credentials.public_key,
          // API-3: use the actual webhook handler route, not a nonexistent /redirect path
          user_confirmation_url: `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/financing/affirm`,
          user_cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/finance/cancelled`,
          user_confirmation_url_action: 'POST',
          ...(credentials.financial_product_key && {
            financial_product_key: credentials.financial_product_key,
          }),
        },
        shipping: {
          name: {
            first: request.applicant.first_name,
            last: request.applicant.last_name,
          },
          address: {
            line1: request.applicant.address.street,
            city: request.applicant.address.city,
            state: request.applicant.address.state,
            zipcode: request.applicant.address.zip,
            country: 'USA',
          },
          phone_number: request.applicant.phone.replace(/\D/g, ''),
          email: request.applicant.email,
        },
        billing: {
          name: {
            first: request.applicant.first_name,
            last: request.applicant.last_name,
          },
          address: {
            line1: request.applicant.address.street,
            city: request.applicant.address.city,
            state: request.applicant.address.state,
            zipcode: request.applicant.address.zip,
            country: 'USA',
          },
          phone_number: request.applicant.phone.replace(/\D/g, ''),
          email: request.applicant.email,
        },
        items: [
          {
            display_name: request.treatment_type || 'Dental Treatment',
            sku: 'dental-treatment',
            unit_price: amountCents,
            qty: 1,
            item_type: 'physical', // Affirm healthcare uses 'physical'
          },
        ],
        discounts: {},
        metadata: {
          mode: 'modal',
          platform_type: 'healthcare',
        },
        order_id: `fin-${crypto.randomUUID()}`,
        currency: 'USD',
        total: amountCents,
      }

      const response = await fetch(`${baseUrl}/api/v1/checkout`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(checkoutPayload),
        signal: AbortSignal.timeout(15_000),
      })

      if (!response.ok) {
        const errorBody = await response.text()
        return {
          status: 'error' as const,
          external_id: null,
          error_message: `Affirm API error ${response.status}: ${errorBody}`,
        }
      }

      const result = await response.json()

      // Affirm returns checkout_token — the patient must complete checkout there.
      // We store the token as external_id and await the webhook.
      return {
        status: 'pending' as const,
        external_id: result.checkout_token || result.id || null,
        raw_response: {
          checkout_token: result.checkout_token,
          redirect_url: result.redirect_url,
        },
      }
    }, RETRY_CONFIGS.financing)
  }

  /**
   * Check status of an Affirm charge by charge_id (not checkout_token).
   * Called after webhook fires to confirm final approval state.
   */
  async checkStatus(
    externalId: string,
    credentials: LenderCredentials
  ): Promise<LenderApplicationResponse> {
    const baseUrl = credentials.api_base_url || 'https://api.affirm.com'
    const authToken = Buffer.from(
      `${credentials.public_key}:${credentials.private_key}`
    ).toString('base64')

    const response = await fetch(`${baseUrl}/api/v2/charges/${externalId}`, {
      headers: { Authorization: `Basic ${authToken}` },
      signal: AbortSignal.timeout(15_000),
    })

    if (!response.ok) {
      return {
        status: 'error',
        external_id: externalId,
        error_message: `Affirm status check failed: ${response.status}`,
      }
    }

    const result = await response.json()

    // Affirm charge events: authorized, confirmed, voided, refunded
    const affirmedStatus = result.status?.toLowerCase()
    if (affirmedStatus === 'authorized' || affirmedStatus === 'confirmed' || affirmedStatus === 'captured') {
      return {
        status: 'approved',
        external_id: externalId,
        approved_amount: result.amount ? result.amount / 100 : undefined,
        terms: result.details
          ? {
              apr: (result.details.apr || 0) / 100, // Affirm stores APR × 100
              term_months: result.details.term,
              monthly_payment: result.details.payment_schedule?.payments?.[0]?.amount
                ? result.details.payment_schedule.payments[0].amount / 100
                : 0,
            }
          : undefined,
      }
    }

    if (affirmedStatus === 'void' || affirmedStatus === 'failed' || affirmedStatus === 'declined') {
      return {
        status: 'denied',
        external_id: externalId,
        denial_reason_code: result.decline_reason || affirmedStatus,
      }
    }

    return { status: 'pending', external_id: externalId }
  }

  /**
   * Verify Affirm webhook signature.
   * Affirm signs payloads with HMAC-SHA256 using the private key.
   */
  verifyWebhook(signature: string, body: string, secret: string): boolean {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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
   * Payment estimates using Affirm's standard APR tiers.
   * Real-time rates require a live checkout — these are representative.
   */
  async getPaymentEstimate(amount: number): Promise<PaymentEstimate[]> {
    const terms = [
      { months: 3,  apr: 0,  promo: 3 },
      { months: 6,  apr: 0,  promo: 6 },
      { months: 12, apr: 10 },
      { months: 18, apr: 15 },
      { months: 24, apr: 20 },
      { months: 36, apr: 26 },
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
        ...('promo' in term && term.promo ? { promo_period_months: term.promo } : {}),
      }
    })
  }
}
