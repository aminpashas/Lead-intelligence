/**
 * Shared types for the connector system.
 *
 * All connectors follow a common event-driven architecture:
 * 1. CRM events (lead created, stage changed, conversion) fire through the dispatcher
 * 2. The dispatcher checks which connectors are enabled for the org
 * 3. Each connector transforms the event to its platform-specific format and sends it
 */

// ── Event types that flow through the connector system ──────────────
export type ConnectorEventType =
  | 'lead.created'
  | 'lead.qualified'
  | 'lead.scored'
  | 'stage.changed'
  | 'consultation.scheduled'
  | 'consultation.completed'
  | 'consultation.no_show'
  | 'treatment.presented'
  | 'treatment.accepted'
  | 'contract.signed'
  | 'treatment.completed'
  | 'lead.lost'
  | 'appointment.booked'
  | 'payment.received'

export type ConnectorEvent = {
  type: ConnectorEventType
  organizationId: string
  leadId: string
  timestamp: string
  data: {
    lead: ConnectorLeadData
    metadata?: Record<string, unknown>
  }
}

/** Minimal lead data passed to connectors (no raw PII unless needed) */
export type ConnectorLeadData = {
  id: string
  firstName: string
  lastName: string
  email?: string | null
  phone?: string | null
  source_type?: string | null
  gclid?: string | null
  fbclid?: string | null
  utm_source?: string | null
  utm_medium?: string | null
  utm_campaign?: string | null
  utm_content?: string | null
  utm_term?: string | null
  ai_score?: number | null
  ai_qualification?: string | null
  treatment_value?: number | null
  actual_revenue?: number | null
  status?: string | null
  stage_slug?: string | null
  city?: string | null
  state?: string | null
  zip_code?: string | null
  created_at?: string | null
  converted_at?: string | null
}

// ── Connector configuration (stored per-org in database) ────────────
export type ConnectorType =
  | 'google_ads'
  | 'meta_capi'
  | 'ga4'
  | 'outbound_webhook'
  | 'slack'
  | 'google_reviews'
  | 'callrail'

export type ConnectorConfig = {
  id: string
  organization_id: string
  connector_type: ConnectorType
  enabled: boolean
  credentials: Record<string, string>
  settings: Record<string, unknown>
  created_at: string
  updated_at: string
}

// ── Google Ads Offline Conversions ──────────────────────────────────
export type GoogleAdsConversionAction = {
  /** The conversion action resource name, e.g. customers/123/conversionActions/456 */
  conversionActionResourceName: string
  /** Human-readable label */
  label: string
  /** Which CRM events trigger this conversion */
  triggerEvents: ConnectorEventType[]
}

export type GoogleAdsConfig = {
  customerId: string              // Google Ads customer ID (no dashes)
  developerToken: string
  clientId: string                // OAuth2 client ID
  clientSecret: string            // OAuth2 client secret
  refreshToken: string            // OAuth2 refresh token
  loginCustomerId?: string        // MCC account ID if managing sub-accounts
  conversionActions: GoogleAdsConversionAction[]
}

// ── Meta Conversions API ────────────────────────────────────────────
export type MetaCAPIConfig = {
  pixelId: string
  accessToken: string
  testEventCode?: string          // For testing, e.g. 'TEST12345'
}

export type MetaCAPIEvent = {
  event_name: string
  event_time: number
  event_source_url?: string
  action_source: 'website' | 'system_generated'
  user_data: {
    em?: string[]   // SHA256-hashed email
    ph?: string[]   // SHA256-hashed phone
    fn?: string[]   // SHA256-hashed first name
    ln?: string[]   // SHA256-hashed last name
    ct?: string[]   // SHA256-hashed city
    st?: string[]   // SHA256-hashed state
    zp?: string[]   // SHA256-hashed zip
    fbc?: string    // Facebook click ID cookie
    fbp?: string    // Facebook browser ID cookie
  }
  custom_data?: {
    value?: number
    currency?: string
    content_name?: string
    content_category?: string
    lead_event_source?: string
    event_id?: string
  }
}

// ── GA4 Measurement Protocol ────────────────────────────────────────
export type GA4Config = {
  measurementId: string           // G-XXXXXXXXXX
  apiSecret: string               // GA4 Measurement Protocol API secret
}

export type GA4Event = {
  name: string
  params: Record<string, string | number | boolean>
}

// ── Outbound Webhooks ───────────────────────────────────────────────
export type OutboundWebhookConfig = {
  url: string
  secret?: string                 // HMAC signing secret for the outbound payload
  events: ConnectorEventType[]    // Which events to forward
  headers?: Record<string, string>
}

// ── Slack ────────────────────────────────────────────────────────────
export type SlackConfig = {
  webhookUrl: string              // Incoming webhook URL
  channel?: string                // Override channel
  events: ConnectorEventType[]    // Which events to notify
}

// ── Connector result ────────────────────────────────────────────────
export type ConnectorResult = {
  connector: ConnectorType
  success: boolean
  statusCode?: number
  error?: string
  responseId?: string
}
