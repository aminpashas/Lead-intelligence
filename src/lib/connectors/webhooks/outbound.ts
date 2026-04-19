/**
 * Outbound Webhook Bridge
 *
 * Sends CRM events to configurable webhook URLs, enabling practices
 * to connect to Zapier, Make.com, n8n, or any custom integration
 * without writing code.
 *
 * Payloads are HMAC-SHA256 signed so receivers can verify authenticity.
 */

import type {
  ConnectorEvent,
  ConnectorResult,
  OutboundWebhookConfig,
} from '../types'
import { hmacSign } from '../utils'

/**
 * Send a CRM event to an outbound webhook URL.
 */
export async function sendOutboundWebhook(
  event: ConnectorEvent,
  config: OutboundWebhookConfig
): Promise<ConnectorResult> {
  // Only send events this webhook is subscribed to
  if (config.events.length > 0 && !config.events.includes(event.type)) {
    return {
      connector: 'outbound_webhook',
      success: true, // Not an error — just not subscribed to this event
    }
  }

  try {
    const payload = JSON.stringify({
      event: event.type,
      timestamp: event.timestamp,
      organization_id: event.organizationId,
      lead: {
        id: event.data.lead.id,
        first_name: event.data.lead.firstName,
        last_name: event.data.lead.lastName,
        email: event.data.lead.email,
        phone: event.data.lead.phone,
        source: event.data.lead.source_type,
        score: event.data.lead.ai_score,
        qualification: event.data.lead.ai_qualification,
        treatment_value: event.data.lead.treatment_value,
        status: event.data.lead.status,
        stage: event.data.lead.stage_slug,
        utm_source: event.data.lead.utm_source,
        utm_medium: event.data.lead.utm_medium,
        utm_campaign: event.data.lead.utm_campaign,
      },
      metadata: event.data.metadata || {},
    })

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'LeadIntelligence-Webhooks/1.0',
      'X-Event-Type': event.type,
      'X-Timestamp': event.timestamp,
      ...config.headers,
    }

    // Sign the payload if a secret is configured
    if (config.secret) {
      const signature = hmacSign(payload, config.secret)
      headers['X-Webhook-Signature'] = signature
    }

    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(10000), // 10s timeout
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      return {
        connector: 'outbound_webhook',
        success: false,
        statusCode: response.status,
        error: `Webhook responded with ${response.status}: ${errorBody.substring(0, 200)}`,
      }
    }

    return {
      connector: 'outbound_webhook',
      success: true,
      statusCode: response.status,
    }
  } catch (err) {
    return {
      connector: 'outbound_webhook',
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    }
  }
}
