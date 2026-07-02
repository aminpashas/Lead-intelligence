/**
 * Meta Lead Ads — inbound lead retrieval + parsing.
 *
 * Meta's `leadgen` webhook does NOT include the answers. `change.value` carries
 * only `leadgen_id`, `page_id`, `form_id`, `ad_id`, `created_time`. The actual
 * field data must be fetched from the Graph API with a Page access token:
 *   GET /{leadgen_id}?fields=field_data,form_id,...&access_token={PAGE_TOKEN}
 *
 * This module isolates the Meta-specific concerns (config load, signature check,
 * Graph fetch, field → IngestInput mapping) so the webhook route can lean on the
 * shared `ingestLead` path for encryption/dedup/consent/audit.
 *
 * @see https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving
 */

import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptCredentials } from '../crypto'

export const META_API_VERSION = 'v21.0'
const META_GRAPH_BASE = 'https://graph.facebook.com'

// ── Config ──────────────────────────────────────────────────────────

export type MetaLeadAdsConfig = {
  /** Facebook App Secret — signs `x-hub-signature-256`. */
  appSecret: string | null
  /** Long-lived Page access token — required to fetch lead field data. */
  pageAccessToken: string | null
  /** Token echoed on the GET subscribe handshake. */
  verifyToken: string | null
}

/**
 * Load Meta Lead Ads credentials for an org. Reads the `meta_capi` (or `meta`)
 * connector row's encrypted credentials, falling back to env vars so a
 * single-tenant deployment can run without per-org config.
 *
 * Credential keys (any of): app_secret, page_access_token, verify_token.
 */
export async function getMetaLeadAdsConfig(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<MetaLeadAdsConfig> {
  let creds: Record<string, unknown> = {}
  const { data } = await supabase
    .from('connector_configs')
    .select('credentials, connector_type')
    .eq('organization_id', organizationId)
    .in('connector_type', ['meta_capi', 'meta'])
    .limit(1)
    .maybeSingle()

  if (data?.credentials) {
    creds = decryptCredentials(data.credentials as Record<string, string>)
  }

  const pick = (k: string) => {
    const v = creds[k]
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }

  return {
    appSecret: pick('app_secret') ?? (process.env.META_APP_SECRET?.trim() || null),
    pageAccessToken:
      pick('page_access_token') ?? (process.env.META_PAGE_ACCESS_TOKEN?.trim() || null),
    verifyToken:
      pick('verify_token') ?? (process.env.META_VERIFY_TOKEN?.trim() || process.env.WEBHOOK_SECRET?.trim() || null),
  }
}

// ── Signature ───────────────────────────────────────────────────────

/**
 * Verify Meta's `x-hub-signature-256` against the App Secret. Meta signs the
 * raw request body with HMAC-SHA256 keyed by the App Secret (NOT an arbitrary
 * shared secret). Returns true when valid.
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  if (!signatureHeader) return false
  const expected =
    'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')
  if (signatureHeader.length !== expected.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected))
  } catch {
    return false
  }
}

// ── Field parsing ───────────────────────────────────────────────────

export type MetaFieldDatum = { name: string; values: string[] }

export type ParsedMetaLead = {
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  city: string | null
  zip: string | null
  /** Tri-state per channel: true = affirmative, undefined = no signal. */
  consent: { sms?: boolean; email?: boolean }
}

const AFFIRMATIVE = new Set([
  'yes',
  'true',
  '1',
  'i agree',
  'i consent',
  'agree',
  'consent',
  'opt in',
  'opt-in',
  'i agree to receive',
])

/** Field-name fragments that indicate a marketing/contact consent question. */
const CONSENT_HINTS = ['consent', 'agree', 'opt_in', 'optin', 'opt-in', 'marketing', 'permission']
const SMS_HINTS = ['sms', 'text', 'phone', 'call']
const EMAIL_HINTS = ['email']

function isAffirmative(value: string | undefined): boolean {
  if (!value) return false
  const v = value.toLowerCase().trim()
  if (AFFIRMATIVE.has(v)) return true
  // A checked Meta consent box often returns the (long) disclaimer text itself.
  return /\b(i (agree|consent)|opt[\s-]?in|yes)\b/.test(v)
}

/**
 * Detect consent from a lead form's custom questions. Conservative: only grants
 * a channel on an explicit affirmative; anything ambiguous stays UNKNOWN so the
 * shared consent path never fabricates a `false` or an unearned `true`.
 */
export function detectMetaConsent(fields: MetaFieldDatum[]): { sms?: boolean; email?: boolean } {
  const out: { sms?: boolean; email?: boolean } = {}
  for (const f of fields) {
    const name = (f.name || '').toLowerCase()
    if (!CONSENT_HINTS.some((h) => name.includes(h))) continue
    if (!isAffirmative(f.values?.[0])) continue
    const sms = SMS_HINTS.some((h) => name.includes(h))
    const email = EMAIL_HINTS.some((h) => name.includes(h))
    if (sms) out.sms = true
    if (email) out.email = true
    // A generic "I agree to be contacted" grants both channels.
    if (!sms && !email) {
      out.sms = true
      out.email = true
    }
  }
  return out
}

/** Parse Meta `field_data` into normalized lead fields. Pure — no I/O. */
export function parseMetaLeadFields(fields: MetaFieldDatum[]): ParsedMetaLead {
  const get = (field: string): string | null =>
    fields.find((f) => f.name === field)?.values?.[0] ?? null

  const full = get('full_name')
  const firstName = get('first_name') || full?.split(' ')[0] || 'Meta Lead'
  const lastName = get('last_name') || (full ? full.split(' ').slice(1).join(' ') : '') || ''

  return {
    firstName,
    lastName,
    email: get('email'),
    phone: get('phone_number') || get('phone'),
    city: get('city'),
    zip: get('zip_code') || get('postal_code'),
    consent: detectMetaConsent(fields),
  }
}

/** True when the parsed lead has at least one contact identifier worth storing. */
export function hasContact(p: ParsedMetaLead): boolean {
  return Boolean(p.email || p.phone)
}

// ── Graph API fetch ─────────────────────────────────────────────────

export type MetaLeadFetch = {
  field_data: MetaFieldDatum[]
  form_id?: string
  ad_id?: string
  campaign_name?: string
  form_name?: string
}

/**
 * Fetch a lead's field data from the Graph API. Returns null on any failure so
 * the caller can skip (and let Meta retry) rather than store a blank lead.
 */
export async function fetchMetaLeadFields(
  leadgenId: string,
  pageAccessToken: string,
): Promise<MetaLeadFetch | null> {
  try {
    const fields = 'field_data,form_id,ad_id,campaign_name,form_name'
    const url = `${META_GRAPH_BASE}/${META_API_VERSION}/${encodeURIComponent(
      leadgenId,
    )}?fields=${fields}&access_token=${encodeURIComponent(pageAccessToken)}`
    const res = await fetch(url, { method: 'GET' })
    if (!res.ok) return null
    const json = (await res.json()) as MetaLeadFetch & { field_data?: MetaFieldDatum[] }
    if (!Array.isArray(json.field_data)) return null
    return json
  } catch {
    return null
  }
}
