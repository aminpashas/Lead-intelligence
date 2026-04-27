/**
 * Connector Event Dispatcher
 *
 * Central hub that routes CRM events to all configured connectors.
 * Each organization can enable/disable connectors independently.
 *
 * Connectors run in parallel and never block the main CRM flow —
 * failures are logged but don't prevent lead creation or stage changes.
 *
 * Usage:
 *   import { dispatchConnectorEvent } from '@/lib/connectors/dispatcher'
 *   await dispatchConnectorEvent(supabase, {
 *     type: 'consultation.scheduled',
 *     organizationId: orgId,
 *     leadId: lead.id,
 *     timestamp: new Date().toISOString(),
 *     data: { lead: buildConnectorLeadData(lead) },
 *   })
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  ConnectorEvent,
  ConnectorResult,
  ConnectorConfig,
  ConnectorType,
  GoogleAdsConfig,
  MetaCAPIConfig,
  GA4Config,
  OutboundWebhookConfig,
  SlackConfig,
} from './types'
import { uploadClickConversion } from './google-ads/offline-conversions'
import { uploadEnhancedConversionForLead } from './google-ads/enhanced-conversions'
import { sendMetaConversionEvent } from './meta/capi'
import { sendGA4Event } from './ga4/measurement'
import { sendOutboundWebhook } from './webhooks/outbound'
import { sendSlackNotification } from './slack/notify'
import { decryptCredentials } from './crypto'

/**
 * Dispatch a CRM event to all enabled connectors for the organization.
 * Runs all connectors in parallel. Never throws — always returns results.
 */
export async function dispatchConnectorEvent(
  supabase: SupabaseClient,
  event: ConnectorEvent
): Promise<ConnectorResult[]> {
  const results: ConnectorResult[] = []

  try {
    // Fetch all enabled connectors for this organization
    const { data: configs } = await supabase
      .from('connector_configs')
      .select('*')
      .eq('organization_id', event.organizationId)
      .eq('enabled', true)

    if (!configs || configs.length === 0) return results

    // Run all connectors in parallel. Credentials are stored AES-GCM-encrypted
    // at rest (see src/lib/connectors/crypto.ts); we decrypt per-row here so
    // each connector module receives plaintext secrets.
    const promises = configs.map((rawConfig) => {
      const config = {
        ...rawConfig,
        credentials: decryptCredentials(rawConfig.credentials),
      } as ConnectorConfig
      return executeConnector(config, event).catch((err) => ({
        connector: rawConfig.connector_type as ConnectorType,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      }))
    })

    const settled = await Promise.allSettled(promises)

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(result.value)
      }
    }

    // Log connector events to database (non-blocking)
    logConnectorEvents(supabase, event, results).catch(() => {
      // Logging failure is non-critical
    })
  } catch {
    // Connector dispatch should never crash the caller
  }

  return results
}

/**
 * Execute a single connector based on its type.
 */
async function executeConnector(
  config: ConnectorConfig,
  event: ConnectorEvent
): Promise<ConnectorResult> {
  switch (config.connector_type) {
    case 'google_ads': {
      // Merge platform-wide OAuth client + dev token with per-org fields.
      // Orgs that went through the OAuth flow only persist customerId +
      // refreshToken (+ optional loginCustomerId) — clientId, clientSecret,
      // and developerToken come from env. Orgs that used the manual form
      // can still override any field.
      const stored = config.credentials as unknown as Partial<GoogleAdsConfig>
      const gadsConfig: GoogleAdsConfig = {
        customerId: stored.customerId || '',
        developerToken: stored.developerToken || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '',
        clientId: stored.clientId || process.env.GOOGLE_ADS_CLIENT_ID || '',
        clientSecret: stored.clientSecret || process.env.GOOGLE_ADS_CLIENT_SECRET || '',
        refreshToken: stored.refreshToken || '',
        loginCustomerId: stored.loginCustomerId,
        conversionActions: stored.conversionActions || [],
      }
      // Prefer the gclid path (highest match accuracy). If we don't have a gclid
      // (offline lead, organic, missed click ID), fall back to Enhanced Conversions
      // for Leads using hashed user identifiers. The conversion action in Google Ads
      // must have "Enhanced conversions for leads" enabled for the EC path to match.
      if (event.data.lead.gclid) {
        return uploadClickConversion(event, gadsConfig)
      }
      return uploadEnhancedConversionForLead(event, gadsConfig)
    }

    case 'meta_capi': {
      const metaConfig = config.credentials as unknown as MetaCAPIConfig
      // Env override: when META_CAPI_TEST_EVENT_CODE is set, force test mode globally.
      // Lets us validate events in Meta Events Manager test view across all orgs without
      // editing each org's connector_configs row.
      const envTestCode = process.env.META_CAPI_TEST_EVENT_CODE
      const effectiveConfig = envTestCode
        ? { ...metaConfig, testEventCode: envTestCode }
        : metaConfig
      return sendMetaConversionEvent(event, effectiveConfig)
    }

    case 'ga4': {
      const ga4Config = config.credentials as unknown as GA4Config
      return sendGA4Event(event, ga4Config)
    }

    case 'outbound_webhook': {
      const webhookConfig = config.credentials as unknown as OutboundWebhookConfig
      return sendOutboundWebhook(event, webhookConfig)
    }

    case 'slack': {
      const slackConfig = config.credentials as unknown as SlackConfig
      return sendSlackNotification(event, slackConfig)
    }

    case 'google_reviews': {
      // Dynamic import to keep bundle light when not used
      const { processReviewRequest } = await import('./google-business/reviews')
      const reviewConfig = config.credentials as unknown as import('./google-business/reviews').GoogleReviewConfig
      return processReviewRequest(event, reviewConfig)
    }

    default:
      return {
        connector: config.connector_type as ConnectorType,
        success: false,
        error: `Unknown connector type: ${config.connector_type}`,
      }
  }
}

/**
 * Log connector event results to the database for auditing.
 */
async function logConnectorEvents(
  supabase: SupabaseClient,
  event: ConnectorEvent,
  results: ConnectorResult[]
): Promise<void> {
  const rows = results
    .filter((r) => r.connector) // skip empty results
    .map((result) => ({
      organization_id: event.organizationId,
      lead_id: event.leadId,
      connector_type: result.connector,
      event_type: event.type,
      success: result.success,
      status_code: result.statusCode || null,
      error_message: result.error || null,
      response_id: result.responseId || null,
      dispatched_at: event.timestamp,
    }))

  if (rows.length > 0) {
    await supabase.from('connector_events').insert(rows)
  }
}
