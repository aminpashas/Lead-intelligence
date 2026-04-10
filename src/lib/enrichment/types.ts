/**
 * Lead Enrichment Types
 *
 * Type definitions for the enrichment pipeline that validates
 * and augments lead data from third-party sources.
 */

export const ENRICHMENT_TYPES = [
  'email_validation',
  'phone_validation',
  'ip_geolocation',
  'google_ads_keyword',
  'website_behavior',
  'credit_prequal',
] as const

export type EnrichmentType = (typeof ENRICHMENT_TYPES)[number]

export const ENRICHMENT_SOURCES: Record<EnrichmentType, string> = {
  email_validation: 'zerobounce',
  phone_validation: 'twilio_lookup',
  ip_geolocation: 'maxmind',
  google_ads_keyword: 'google_ads_api',
  website_behavior: 'client_js',
  credit_prequal: 'internal_model',
}

// Database row type
export type LeadEnrichment = {
  id: string
  organization_id: string
  lead_id: string
  enrichment_type: EnrichmentType
  enrichment_source: string
  status: 'pending' | 'success' | 'failed' | 'skipped'
  data: Record<string, unknown>
  error_message: string | null
  confidence_score: number | null
  enriched_at: string
  expires_at: string | null
  created_at: string
}

// ── Provider Result Types ──────────────────────────────────

export type EmailValidationResult = {
  status: 'valid' | 'invalid' | 'catch-all' | 'spamtrap' | 'abuse' | 'do_not_mail' | 'unknown'
  sub_status: string | null
  free_email: boolean
  disposable: boolean
  did_you_mean: string | null
  domain: string | null
  domain_age_days: number | null
  smtp_provider: string | null
  mx_found: boolean
}

export type PhoneValidationResult = {
  valid: boolean
  line_type: 'mobile' | 'landline' | 'voip' | 'toll_free' | 'unknown'
  carrier: string | null
  caller_name: string | null
  country_code: string
  national_format: string | null
}

export type IPGeolocationResult = {
  ip: string
  city: string | null
  region: string | null
  country: string | null
  postal_code: string | null
  latitude: number | null
  longitude: number | null
  timezone: string | null
  isp: string | null
  is_proxy: boolean
  is_vpn: boolean
  distance_to_practice_miles: number | null
}

export type GoogleAdsKeywordResult = {
  campaign_name: string | null
  ad_group_name: string | null
  keyword: string | null
  match_type: string | null
  device: string | null
}

export type WebsiteBehaviorResult = {
  pages_visited: string[]
  time_on_site_seconds: number
  pricing_page_viewed: boolean
  financing_page_viewed: boolean
  testimonials_viewed: boolean
  before_after_viewed: boolean
  device_type: 'desktop' | 'mobile' | 'tablet'
  browser: string | null
  session_count: number
  form_time_seconds: number | null
}

// ── Enrichment Summary (for AI scoring) ────────────────────

export type EnrichmentSummary = {
  email_valid: boolean | null
  email_disposable: boolean | null
  email_free: boolean | null
  phone_valid: boolean | null
  phone_line_type: string | null
  ip_location_match: boolean | null
  ip_is_proxy: boolean | null
  distance_to_practice_miles: number | null
  search_keyword: string | null
  pricing_page_viewed: boolean | null
  financing_page_viewed: boolean | null
  time_on_site_seconds: number | null
  session_count: number | null
  enrichment_score: number
  identity_confidence: number
}

// ── Config ─────────────────────────────────────────────────

export type EnrichmentProviderConfig = {
  enabled: boolean
}

export type EnrichmentConfig = Record<EnrichmentType, EnrichmentProviderConfig>

export const DEFAULT_ENRICHMENT_CONFIG: EnrichmentConfig = {
  email_validation: { enabled: true },
  phone_validation: { enabled: true },
  ip_geolocation: { enabled: true },
  google_ads_keyword: { enabled: true },
  website_behavior: { enabled: true },
  credit_prequal: { enabled: true },
}

export const ENRICHMENT_TTL_DAYS = 30
