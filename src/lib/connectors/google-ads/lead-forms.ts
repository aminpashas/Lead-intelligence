/**
 * Google Ads Lead Form Extensions — inbound lead parsing + auth.
 *
 * Google's real lead-form webhook does NOT send an HMAC header. It POSTs JSON
 * with the lead answers in `user_column_data` and echoes a shared-secret string
 * in `google_key` — the "Key" you configure on the lead form. Authentication is
 * a constant-time compare of that key. (The prior handler required an
 * `x-webhook-signature` HMAC and so rejected every real Google submission.)
 *
 * @see https://support.google.com/google-ads/answer/7519050  (webhook + key)
 */

import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptCredentials } from '../crypto'

export type GoogleLeadFormConfig = {
  /** The lead-form "Key" Google echoes in `google_key`. */
  leadFormKey: string | null
}

/**
 * Load the Google Lead Form key for an org from the `google_ads` connector
 * credentials (key `lead_form_key`), falling back to env GOOGLE_LEAD_FORM_KEY.
 */
export async function getGoogleLeadFormConfig(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<GoogleLeadFormConfig> {
  let creds: Record<string, unknown> = {}
  const { data } = await supabase
    .from('connector_configs')
    .select('credentials')
    .eq('organization_id', organizationId)
    .eq('connector_type', 'google_ads')
    .limit(1)
    .maybeSingle()

  if (data?.credentials) {
    creds = decryptCredentials(data.credentials as Record<string, string>)
  }

  const fromCreds =
    typeof creds.lead_form_key === 'string' && creds.lead_form_key.trim()
      ? creds.lead_form_key.trim()
      : null

  return { leadFormKey: fromCreds ?? (process.env.GOOGLE_LEAD_FORM_KEY?.trim() || null) }
}

/** Constant-time compare of the submitted `google_key` against the configured one. */
export function verifyGoogleKey(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false
  if (provided.length !== expected.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  } catch {
    return false
  }
}

// ── Field parsing ───────────────────────────────────────────────────

export type GoogleColumn = { column_id?: string; string_value?: string }

export type ParsedGoogleLead = {
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  city: string | null
  zip: string | null
}

/**
 * Parse a Google lead-form body. Handles both the native `user_column_data`
 * array and a flattened shape (e.g. from a relay). Pure — no I/O.
 */
export function parseGoogleLeadColumns(body: Record<string, unknown>): ParsedGoogleLead {
  const cols = Array.isArray(body.user_column_data)
    ? (body.user_column_data as GoogleColumn[])
    : []
  const col = (id: string): string | null =>
    cols.find((c) => c.column_id === id)?.string_value?.trim() || null

  const flat = (k: string): string | null => {
    const v = body[k]
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }

  const full = col('FULL_NAME') || flat('full_name')
  const firstName =
    col('FIRST_NAME') || flat('first_name') || full?.split(' ')[0] || 'Google Lead'
  const lastName =
    col('LAST_NAME') ||
    flat('last_name') ||
    (full ? full.split(' ').slice(1).join(' ') : '') ||
    ''

  return {
    firstName,
    lastName,
    email: col('EMAIL') || flat('email'),
    phone: col('PHONE_NUMBER') || flat('phone'),
    city: col('CITY') || flat('city'),
    zip: col('POSTAL_CODE') || flat('zip_code'),
  }
}

/** True when the parsed lead has at least one contact identifier worth storing. */
export function hasGoogleContact(p: ParsedGoogleLead): boolean {
  return Boolean(p.email || p.phone)
}

/** Google sends `is_test: true` for the form's "Send test data" button. */
export function isGoogleTestLead(body: Record<string, unknown>): boolean {
  return body.is_test === true || body.is_test === 'true'
}
