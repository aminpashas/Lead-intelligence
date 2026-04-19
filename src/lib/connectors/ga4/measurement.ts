/**
 * Google Analytics 4 — Measurement Protocol
 *
 * Sends server-side events to GA4 for CRM actions that happen outside
 * the browser (stage changes, AI scoring, conversions). This bridges
 * the gap between website analytics and backend pipeline activity.
 *
 * @see https://developers.google.com/analytics/devguides/collection/protocol/ga4
 */

import type {
  ConnectorEvent,
  ConnectorResult,
  GA4Config,
  ConnectorEventType,
} from '../types'

const GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect'
const GA4_DEBUG_ENDPOINT = 'https://www.google-analytics.com/debug/mp/collect'

// Map CRM events to GA4 event names (snake_case per GA4 convention)
const GA4_EVENT_MAP: Record<ConnectorEventType, string> = {
  'lead.created': 'generate_lead',
  'lead.qualified': 'qualify_lead',
  'lead.scored': 'score_lead',
  'stage.changed': 'pipeline_stage_change',
  'consultation.scheduled': 'book_consultation',
  'consultation.completed': 'complete_consultation',
  'consultation.no_show': 'consultation_no_show',
  'treatment.presented': 'present_treatment',
  'treatment.accepted': 'accept_treatment',
  'contract.signed': 'sign_contract',
  'treatment.completed': 'purchase',
  'lead.lost': 'lead_lost',
  'appointment.booked': 'book_appointment',
  'payment.received': 'payment_received',
}

/**
 * Send a server-side event to GA4 via Measurement Protocol.
 */
export async function sendGA4Event(
  event: ConnectorEvent,
  config: GA4Config,
  options?: { debug?: boolean }
): Promise<ConnectorResult> {
  const eventName = GA4_EVENT_MAP[event.type]
  if (!eventName) {
    return {
      connector: 'ga4',
      success: false,
      error: `No GA4 event mapped for: ${event.type}`,
    }
  }

  const { lead, metadata } = event.data

  try {
    // Build event parameters
    const params: Record<string, string | number> = {
      lead_id: lead.id,
      lead_source: lead.source_type || 'unknown',
      engagement_time_msec: 100,  // Required by GA4
    }

    // Add value for monetary events
    if (lead.treatment_value && ['sign_contract', 'accept_treatment', 'purchase', 'payment_received'].includes(eventName)) {
      params.value = lead.actual_revenue || lead.treatment_value
      params.currency = 'USD'
    }

    // Add qualification data
    if (lead.ai_qualification) {
      params.lead_qualification = lead.ai_qualification
    }
    if (lead.ai_score) {
      params.lead_score = lead.ai_score
    }

    // Add UTM data for attribution
    if (lead.utm_source) params.source = lead.utm_source
    if (lead.utm_medium) params.medium = lead.utm_medium
    if (lead.utm_campaign) params.campaign = lead.utm_campaign

    // Add stage change context
    if (metadata?.old_stage) params.from_stage = metadata.old_stage as string
    if (metadata?.new_stage) params.to_stage = metadata.new_stage as string

    // Use lead ID as client_id (GA4 requires one)
    // In production, you'd use the GA4 client_id cookie from the website visit
    const clientId = lead.id.replace(/-/g, '').substring(0, 32) || 'server_generated'

    const payload = {
      client_id: clientId,
      events: [
        {
          name: eventName,
          params,
        },
      ],
    }

    const endpoint = options?.debug ? GA4_DEBUG_ENDPOINT : GA4_ENDPOINT
    const url = `${endpoint}?measurement_id=${config.measurementId}&api_secret=${config.apiSecret}`

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    // GA4 Measurement Protocol returns 204 No Content on success
    // Debug endpoint returns 200 with validation messages
    if (options?.debug) {
      const debugResult = await response.json()
      if (debugResult.validationMessages?.length > 0) {
        return {
          connector: 'ga4',
          success: false,
          error: `Validation errors: ${JSON.stringify(debugResult.validationMessages)}`,
        }
      }
    }

    if (response.status === 204 || response.status === 200) {
      return {
        connector: 'ga4',
        success: true,
        statusCode: response.status,
      }
    }

    return {
      connector: 'ga4',
      success: false,
      statusCode: response.status,
      error: `Unexpected status: ${response.status}`,
    }
  } catch (err) {
    return {
      connector: 'ga4',
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    }
  }
}
