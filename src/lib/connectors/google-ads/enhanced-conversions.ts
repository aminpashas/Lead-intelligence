/**
 * Google Ads — Enhanced Conversions for Leads (user-data path).
 *
 * Used when we don't have a gclid (offline lead, missed click ID, organic conversion).
 * Sends hashed user identifiers (email, phone, name+address) instead, and Google
 * matches them server-side against authenticated user signals on the ad-click side.
 *
 * Brief reference: §3.4 — "Enhanced Conversions for Leads via user-provided data —
 * works even when gclid is missing."
 *
 * Endpoint:    customers/{cid}:uploadConversionAdjustments
 * Adjustment:  type ENHANCEMENT
 *
 * @see https://developers.google.com/google-ads/api/docs/conversions/enhanced-conversions/leads
 *
 * NOTE: For this to work, the conversion action in Google Ads must have
 * "Enhanced conversions for leads" turned on AND the original conversion
 * must have been recorded by Google Ads (typically via a website tag or a
 * gclid-based offline upload). When no source conversion exists, Google will
 * accept the adjustment but won't be able to match it.
 */

import type {
  ConnectorEvent,
  ConnectorResult,
  GoogleAdsConfig,
  ConnectorEventType,
} from '../types'
import { hashForMatching } from '../utils'

const GOOGLE_ADS_API_VERSION = 'v18'
const GOOGLE_ADS_API_BASE = 'https://googleads.googleapis.com'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

const DEFAULT_CONVERSION_MAP: Record<ConnectorEventType, string> = {
  'lead.created': 'Lead Form Submit',
  'lead.qualified': 'Qualified Lead',
  'lead.scored': '',
  'stage.changed': '',
  'consultation.scheduled': 'Consultation Booked',
  'consultation.completed': 'Consultation Completed',
  'consultation.no_show': '',
  'treatment.presented': 'Treatment Presented',
  'treatment.accepted': 'Treatment Accepted',
  'contract.signed': 'Contract Signed',
  'treatment.completed': 'Treatment Completed',
  'lead.lost': '',
  'appointment.booked': 'Appointment Booked',
  'payment.received': 'Revenue',
}

async function getAccessToken(config: GoogleAdsConfig): Promise<string> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Google OAuth token refresh failed: ${error}`)
  }
  const data = await response.json()
  return data.access_token
}

/**
 * Upload an Enhanced Conversion for Leads via user-provided data.
 *
 * Caller's responsibility: only invoke this when uploadClickConversion can't (no gclid).
 * The dispatcher decides which path to take in google-ads/dispatch.ts.
 */
export async function uploadEnhancedConversionForLead(
  event: ConnectorEvent,
  config: GoogleAdsConfig
): Promise<ConnectorResult> {
  const { lead } = event.data

  if (!lead.email && !lead.phone) {
    return {
      connector: 'google_ads',
      success: false,
      error: 'No email or phone — cannot send Enhanced Conversion (need at least one user identifier).',
    }
  }

  const conversionAction = config.conversionActions?.find((ca) =>
    ca.triggerEvents.includes(event.type)
  )
  const conversionName = conversionAction?.label || DEFAULT_CONVERSION_MAP[event.type]
  if (!conversionName) {
    return {
      connector: 'google_ads',
      success: false,
      error: `No conversion action mapped for event type: ${event.type}`,
    }
  }

  try {
    const accessToken = await getAccessToken(config)

    const userIdentifiers: Record<string, unknown>[] = []
    if (lead.email) {
      userIdentifiers.push({ hashedEmail: hashForMatching(lead.email.toLowerCase().trim()) })
    }
    if (lead.phone) {
      userIdentifiers.push({ hashedPhoneNumber: hashForMatching(lead.phone.replace(/\D/g, '')) })
    }
    // Address identifier — hashed first/last + raw city/state/zip per Google's spec
    if (lead.firstName || lead.lastName || lead.zip_code) {
      const addressInfo: Record<string, unknown> = {}
      if (lead.firstName) addressInfo.hashedFirstName = hashForMatching(lead.firstName.toLowerCase().trim())
      if (lead.lastName) addressInfo.hashedLastName = hashForMatching(lead.lastName.toLowerCase().trim())
      if (lead.city) addressInfo.city = lead.city
      if (lead.state) addressInfo.state = lead.state
      if (lead.zip_code) addressInfo.postalCode = lead.zip_code
      addressInfo.countryCode = 'US'
      userIdentifiers.push({ addressInfo })
    }

    const adjustment: Record<string, unknown> = {
      conversionAction: conversionAction?.conversionActionResourceName
        || `customers/${config.customerId}/conversionActions/${conversionName}`,
      adjustmentType: 'ENHANCEMENT',
      adjustmentDateTime: formatGoogleAdsDate(event.timestamp),
      userIdentifiers,
      // orderId is the Google-recommended dedupe key when no gclid exists.
      // We use leadId + event_type + timestamp so the same logical conversion
      // is never double-counted across retries.
      orderId: `${lead.id}_${event.type}_${Math.floor(new Date(event.timestamp).getTime() / 1000)}`,
      userAgent: 'CRM-Server-Side',
    }

    // Include conversion value for revenue events
    if (event.type === 'payment.received' && lead.actual_revenue) {
      adjustment.restatementValue = {
        adjustedValue: lead.actual_revenue,
        currencyCode: 'USD',
      }
    } else if (lead.treatment_value && ['contract.signed', 'treatment.accepted'].includes(event.type)) {
      adjustment.restatementValue = {
        adjustedValue: lead.treatment_value,
        currencyCode: 'USD',
      }
    }

    const url = `${GOOGLE_ADS_API_BASE}/${GOOGLE_ADS_API_VERSION}/customers/${config.customerId}:uploadConversionAdjustments`

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'developer-token': config.developerToken,
    }
    if (config.loginCustomerId) {
      headers['login-customer-id'] = config.loginCustomerId
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        conversionAdjustments: [adjustment],
        partialFailure: true,
      }),
    })

    if (!response.ok) {
      const errorBody = await response.text()
      return {
        connector: 'google_ads',
        success: false,
        statusCode: response.status,
        error: `Google Ads Enhanced Conversions API error: ${errorBody}`,
      }
    }

    const result = await response.json()
    if (result.partialFailureError) {
      return {
        connector: 'google_ads',
        success: false,
        error: `Partial failure: ${JSON.stringify(result.partialFailureError)}`,
      }
    }

    return { connector: 'google_ads', success: true, statusCode: 200 }
  } catch (err) {
    return {
      connector: 'google_ads',
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    }
  }
}

function formatGoogleAdsDate(isoDate: string): string {
  const d = new Date(isoDate)
  const pad = (n: number) => n.toString().padStart(2, '0')
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const absOffset = Math.abs(offset)
  const offsetHours = Math.floor(absOffset / 60)
  const offsetMinutes = absOffset % 60

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(offsetHours)}:${pad(offsetMinutes)}`
}
