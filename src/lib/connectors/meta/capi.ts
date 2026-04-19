/**
 * Meta Conversions API (CAPI) Connector
 *
 * Sends server-side conversion events to Meta/Facebook so the ad platform
 * can attribute conversions that browser pixels miss (iOS privacy, ad blockers).
 *
 * Events are sent to: POST https://graph.facebook.com/v21.0/{pixel_id}/events
 *
 * PII is SHA256-hashed before transmission (Meta's requirement).
 *
 * @see https://developers.facebook.com/docs/marketing-api/conversions-api
 */

import type {
  ConnectorEvent,
  ConnectorResult,
  MetaCAPIConfig,
  MetaCAPIEvent,
  ConnectorEventType,
} from '../types'
import { hashForMatching } from '../utils'

const META_API_VERSION = 'v21.0'
const META_GRAPH_BASE = 'https://graph.facebook.com'

// Map CRM events to Meta standard/custom event names
const EVENT_NAME_MAP: Record<ConnectorEventType, string> = {
  'lead.created': 'Lead',
  'lead.qualified': 'QualifiedLead',
  'lead.scored': '',
  'stage.changed': '',
  'consultation.scheduled': 'Schedule',
  'consultation.completed': 'ConsultationCompleted',
  'consultation.no_show': '',
  'treatment.presented': 'TreatmentPresented',
  'treatment.accepted': 'TreatmentAccepted',
  'contract.signed': 'StartTrial',
  'treatment.completed': 'Purchase',
  'lead.lost': '',
  'appointment.booked': 'Schedule',
  'payment.received': 'Purchase',
}

/**
 * Send a server-side event to Meta Conversions API.
 */
export async function sendMetaConversionEvent(
  event: ConnectorEvent,
  config: MetaCAPIConfig
): Promise<ConnectorResult> {
  const { lead } = event.data

  const eventName = EVENT_NAME_MAP[event.type]
  if (!eventName) {
    return {
      connector: 'meta_capi',
      success: false,
      error: `No Meta event mapped for: ${event.type}`,
    }
  }

  try {
    // Build user_data with hashed PII
    const userData: MetaCAPIEvent['user_data'] = {
      action_source: 'system_generated',
    } as MetaCAPIEvent['user_data']

    if (lead.email) {
      userData.em = [hashForMatching(lead.email.toLowerCase().trim())]
    }
    if (lead.phone) {
      userData.ph = [hashForMatching(lead.phone.replace(/\D/g, ''))]
    }
    if (lead.firstName) {
      userData.fn = [hashForMatching(lead.firstName.toLowerCase().trim())]
    }
    if (lead.lastName) {
      userData.ln = [hashForMatching(lead.lastName.toLowerCase().trim())]
    }
    if (lead.city) {
      userData.ct = [hashForMatching(lead.city.toLowerCase().trim())]
    }
    if (lead.state) {
      userData.st = [hashForMatching(lead.state.toLowerCase().trim())]
    }
    if (lead.zip_code) {
      userData.zp = [hashForMatching(lead.zip_code.trim())]
    }
    // Pass through fbclid if available
    if (lead.fbclid) {
      userData.fbc = `fb.1.${Date.now()}.${lead.fbclid}`
    }

    // Build the event
    const metaEvent: MetaCAPIEvent = {
      event_name: eventName,
      event_time: Math.floor(new Date(event.timestamp).getTime() / 1000),
      action_source: 'system_generated',
      user_data: userData,
    }

    // Add custom_data for value-bearing events
    if (['Purchase', 'StartTrial', 'TreatmentAccepted'].includes(eventName)) {
      metaEvent.custom_data = {
        value: lead.actual_revenue || lead.treatment_value || 0,
        currency: 'USD',
        content_name: event.type === 'treatment.completed' ? 'Treatment Completed' : 'Case Accepted',
        lead_event_source: 'crm',
        event_id: `${lead.id}_${event.type}_${event.timestamp}`,
      }
    } else {
      metaEvent.custom_data = {
        content_name: eventName,
        content_category: 'dental_implants',
        lead_event_source: 'crm',
        event_id: `${lead.id}_${event.type}_${event.timestamp}`,
      }
    }

    // Build request payload
    const payload: Record<string, unknown> = {
      data: [metaEvent],
    }

    // Add test event code for testing
    if (config.testEventCode) {
      payload.test_event_code = config.testEventCode
    }

    const url = `${META_GRAPH_BASE}/${META_API_VERSION}/${config.pixelId}/events?access_token=${config.accessToken}`

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const result = await response.json()

    if (!response.ok) {
      return {
        connector: 'meta_capi',
        success: false,
        statusCode: response.status,
        error: result.error?.message || JSON.stringify(result),
      }
    }

    return {
      connector: 'meta_capi',
      success: true,
      statusCode: 200,
      responseId: result.events_received ? `${result.events_received} events` : undefined,
    }
  } catch (err) {
    return {
      connector: 'meta_capi',
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    }
  }
}
