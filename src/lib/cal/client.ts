/**
 * Cal.com API v2 client.
 *
 * Per-org credentials live in the `connector_configs` table (connector_type='cal_com'):
 *   credentials.api_key            — Cal.com API key (Bearer token)
 *   credentials.webhook_secret     — HMAC secret for verifying inbound webhooks
 *   settings.event_types           — array of { slug, cal_event_type_id, label, duration_minutes }
 *                                    e.g. [{ slug: 'aox-consult', cal_event_type_id: 12345, label: 'AOX Consult', duration_minutes: 60 }]
 *   settings.booking_base_url      — e.g. https://cal.com/dion-health
 *
 * Brief reference: Section 2.4 (Cal.com Integration).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const CAL_API_BASE = 'https://api.cal.com/v2'

export type CalEventTypeConfig = {
  slug: string                    // internal identifier, e.g. 'aox-consult'
  cal_event_type_id: number       // Cal.com numeric event type ID
  label: string                   // display name
  duration_minutes: number
}

export type CalConfig = {
  api_key: string
  webhook_secret: string
  event_types: CalEventTypeConfig[]
  booking_base_url: string        // e.g. https://cal.com/dion-health
}

/**
 * Load Cal.com config for an organization. Returns null if not configured / disabled.
 */
export async function getCalConfig(
  supabase: SupabaseClient,
  organizationId: string
): Promise<CalConfig | null> {
  const { data } = await supabase
    .from('connector_configs')
    .select('credentials, settings, enabled')
    .eq('organization_id', organizationId)
    .eq('connector_type', 'cal_com')
    .single()

  if (!data || !data.enabled) return null

  const creds = (data.credentials || {}) as Partial<{ api_key: string; webhook_secret: string }>
  const settings = (data.settings || {}) as Partial<{ event_types: CalEventTypeConfig[]; booking_base_url: string }>

  if (!creds.api_key || !settings.booking_base_url) return null

  return {
    api_key: creds.api_key,
    webhook_secret: creds.webhook_secret || '',
    event_types: settings.event_types || [],
    booking_base_url: settings.booking_base_url,
  }
}

/**
 * Lightweight wrapper around fetch for Cal.com API calls.
 * Used for things like fetching event-type details on-demand;
 * most workflows are webhook-driven and don't need polling.
 */
export async function calApi<T>(
  config: CalConfig,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${CAL_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.api_key}`,
      'Content-Type': 'application/json',
      'cal-api-version': '2024-08-13',
      ...(init?.headers || {}),
    },
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Cal.com API ${res.status}: ${text || res.statusText}`)
  }

  return res.json() as Promise<T>
}
