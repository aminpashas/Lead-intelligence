/**
 * Connector Helpers
 *
 * Utility functions for building connector event data from CRM entities.
 */

import type { ConnectorLeadData } from './types'
import { decryptField } from '@/lib/encryption'

/**
 * Build a ConnectorLeadData from a raw Supabase lead row.
 * Handles PII decryption so connectors receive clean data.
 */
export function buildConnectorLeadData(lead: Record<string, unknown>): ConnectorLeadData {
  return {
    id: lead.id as string,
    firstName: (lead.first_name as string) || '',
    lastName: (lead.last_name as string) || '',
    email: decryptIfNeeded(lead.email as string | null),
    phone: decryptIfNeeded(lead.phone_formatted as string | null) || decryptIfNeeded(lead.phone as string | null),
    source_type: lead.source_type as string | null,
    gclid: lead.gclid as string | null,
    fbclid: lead.fbclid as string | null,
    fbc: lead.fbc as string | null,
    fbp: lead.fbp as string | null,
    utm_source: lead.utm_source as string | null,
    utm_medium: lead.utm_medium as string | null,
    utm_campaign: lead.utm_campaign as string | null,
    utm_content: lead.utm_content as string | null,
    utm_term: lead.utm_term as string | null,
    ai_score: lead.ai_score as number | null,
    ai_qualification: lead.ai_qualification as string | null,
    treatment_value: lead.treatment_value as number | null,
    actual_revenue: lead.actual_revenue as number | null,
    status: lead.status as string | null,
    stage_slug: lead.stage_slug as string | null,
    city: lead.city as string | null,
    state: lead.state as string | null,
    zip_code: lead.zip_code as string | null,
    created_at: lead.created_at as string | null,
    converted_at: lead.converted_at as string | null,
  }
}

/**
 * Attempt to decrypt a field, returning the original value if decryption
 * is not needed (field isn't encrypted) or fails.
 */
function decryptIfNeeded(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const decrypted = decryptField(value)
    return decrypted || value
  } catch {
    return value
  }
}
