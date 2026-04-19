/**
 * Google Ads Offline Conversion Upload
 *
 * Pushes CRM conversion events back to Google Ads so Smart Bidding
 * can optimize for downstream outcomes (consultations, case acceptance,
 * revenue) rather than just form fills.
 *
 * Uses the Google Ads API v18 UploadClickConversions endpoint.
 * Requires: OAuth2 refresh token, developer token, customer ID.
 *
 * @see https://developers.google.com/google-ads/api/docs/conversions/upload-clicks
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

// Map CRM events to default conversion action names
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

/**
 * Get a fresh access token using the OAuth2 refresh token.
 */
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
 * Upload a single click conversion to Google Ads.
 *
 * This matches the lead's gclid to the original ad click and reports
 * the downstream conversion event (consultation booked, case closed, etc.)
 */
export async function uploadClickConversion(
  event: ConnectorEvent,
  config: GoogleAdsConfig
): Promise<ConnectorResult> {
  const { lead, metadata } = event.data

  // Must have a gclid to match the conversion to an ad click
  if (!lead.gclid) {
    return {
      connector: 'google_ads',
      success: false,
      error: 'No gclid on lead — cannot attribute to Google Ads click',
    }
  }

  // Find the matching conversion action for this event type
  const conversionAction = config.conversionActions?.find((ca) =>
    ca.triggerEvents.includes(event.type)
  )

  // Fallback to default conversion name
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

    // Build the conversion payload
    const conversionPayload: Record<string, unknown> = {
      gclid: lead.gclid,
      conversionAction: conversionAction?.conversionActionResourceName
        || `customers/${config.customerId}/conversionActions/${conversionName}`,
      conversionDateTime: formatGoogleAdsDate(event.timestamp),
    }

    // Include conversion value for revenue events
    if (event.type === 'payment.received' && lead.actual_revenue) {
      conversionPayload.conversionValue = lead.actual_revenue
      conversionPayload.currencyCode = 'USD'
    } else if (lead.treatment_value && ['contract.signed', 'treatment.accepted'].includes(event.type)) {
      conversionPayload.conversionValue = lead.treatment_value
      conversionPayload.currencyCode = 'USD'
    }

    // Add user identifiers for enhanced conversions
    if (lead.email || lead.phone) {
      conversionPayload.userIdentifiers = []
      if (lead.email) {
        (conversionPayload.userIdentifiers as Record<string, unknown>[]).push({
          hashedEmail: hashForMatching(lead.email.toLowerCase().trim()),
        })
      }
      if (lead.phone) {
        (conversionPayload.userIdentifiers as Record<string, unknown>[]).push({
          hashedPhoneNumber: hashForMatching(lead.phone.replace(/\D/g, '')),
        })
      }
    }

    const url = `${GOOGLE_ADS_API_BASE}/${GOOGLE_ADS_API_VERSION}/customers/${config.customerId}:uploadClickConversions`

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${accessToken}`,
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
        conversions: [conversionPayload],
        partialFailure: true,
      }),
    })

    if (!response.ok) {
      const errorBody = await response.text()
      return {
        connector: 'google_ads',
        success: false,
        statusCode: response.status,
        error: `Google Ads API error: ${errorBody}`,
      }
    }

    const result = await response.json()

    // Check for partial failures
    if (result.partialFailureError) {
      return {
        connector: 'google_ads',
        success: false,
        error: `Partial failure: ${JSON.stringify(result.partialFailureError)}`,
      }
    }

    return {
      connector: 'google_ads',
      success: true,
      statusCode: 200,
    }
  } catch (err) {
    return {
      connector: 'google_ads',
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    }
  }
}

/**
 * Format a date string for Google Ads API.
 * Google Ads requires: "yyyy-mm-dd hh:mm:ss+|-hh:mm"
 */
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
