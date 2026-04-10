/**
 * Lead Enrichment Orchestrator
 *
 * Coordinates all enrichment providers, stores results, computes
 * enrichment scores, and updates derived fields on the lead.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Lead } from '@/types/database'
import {
  type EnrichmentConfig,
  type EnrichmentSummary,
  type EnrichmentType,
  ENRICHMENT_SOURCES,
  ENRICHMENT_TTL_DAYS,
  DEFAULT_ENRICHMENT_CONFIG,
} from './types'
import { validateEmail, emailValidationConfidence } from './email-validator'
import { validatePhone, phoneValidationConfidence } from './phone-validator'
import { geolocateIP, ipGeolocationConfidence } from './ip-geolocation'
import { extractGoogleAdsKeyword, googleAdsKeywordConfidence } from './google-ads-keyword'
import { parseWebsiteBehavior, websiteBehaviorConfidence } from './website-behavior'
import { autoPreQualify, preQualConfidence } from './credit-prequal'
import { auditPHITransmission } from '@/lib/hipaa-audit'

type EnrichmentResult = {
  type: EnrichmentType
  status: 'success' | 'failed' | 'skipped'
  data: Record<string, unknown>
  confidence: number
  error?: string
}

/**
 * Enrich a lead with all applicable data sources.
 * Runs providers in parallel, stores results, and updates the lead.
 */
export async function enrichLead(
  supabase: SupabaseClient,
  lead: Lead,
  config?: Partial<EnrichmentConfig>
): Promise<{
  enrichments: Array<{ type: EnrichmentType; status: string }>
  summary: EnrichmentSummary
  enrichment_score: number
}> {
  const mergedConfig = { ...DEFAULT_ENRICHMENT_CONFIG, ...config }
  const results: EnrichmentResult[] = []

  // Determine which enrichments to run
  const tasks: Array<() => Promise<EnrichmentResult>> = []

  if (mergedConfig.email_validation.enabled && lead.email) {
    const shouldRun = await shouldEnrich(supabase, lead.id, 'email_validation')
    if (shouldRun) {
      tasks.push(async () => {
        try {
          // HIPAA: Log email transmission to ZeroBounce
          await auditPHITransmission(
            { supabase, organizationId: lead.organization_id, actorType: 'system' },
            'lead', lead.id, 'zerobounce', ['email']
          )
          const data = await validateEmail(lead.email!)
          return {
            type: 'email_validation' as const,
            status: 'success' as const,
            data: data as unknown as Record<string, unknown>,
            confidence: emailValidationConfidence(data),
          }
        } catch (err) {
          return {
            type: 'email_validation' as const,
            status: 'failed' as const,
            data: {},
            confidence: 0,
            error: err instanceof Error ? err.message : 'Unknown error',
          }
        }
      })
    }
  }

  if (mergedConfig.phone_validation.enabled && lead.phone) {
    const shouldRun = await shouldEnrich(supabase, lead.id, 'phone_validation')
    if (shouldRun) {
      tasks.push(async () => {
        try {
          await auditPHITransmission(
            { supabase, organizationId: lead.organization_id, actorType: 'system' },
            'lead', lead.id, 'twilio_lookup', ['phone']
          )
          const phoneToValidate = lead.phone_formatted || lead.phone!
          const data = await validatePhone(phoneToValidate)
          return {
            type: 'phone_validation' as const,
            status: 'success' as const,
            data: data as unknown as Record<string, unknown>,
            confidence: phoneValidationConfidence(data),
          }
        } catch (err) {
          return {
            type: 'phone_validation' as const,
            status: 'failed' as const,
            data: {},
            confidence: 0,
            error: err instanceof Error ? err.message : 'Unknown error',
          }
        }
      })
    }
  }

  if (mergedConfig.ip_geolocation.enabled && lead.ip_address) {
    const shouldRun = await shouldEnrich(supabase, lead.id, 'ip_geolocation')
    if (shouldRun) {
      tasks.push(async () => {
        try {
          // Get practice location from org settings if available
          const { data: org } = await supabase
            .from('organizations')
            .select('settings')
            .eq('id', lead.organization_id)
            .single()

          const practiceLocation = org?.settings?.practice_location as
            | { lat: number; lng: number }
            | undefined

          await auditPHITransmission(
            { supabase, organizationId: lead.organization_id, actorType: 'system' },
            'lead', lead.id, 'maxmind', ['address']
          )
          const data = await geolocateIP(lead.ip_address!, practiceLocation)
          return {
            type: 'ip_geolocation' as const,
            status: 'success' as const,
            data: data as unknown as Record<string, unknown>,
            confidence: ipGeolocationConfidence(data),
          }
        } catch (err) {
          return {
            type: 'ip_geolocation' as const,
            status: 'failed' as const,
            data: {},
            confidence: 0,
            error: err instanceof Error ? err.message : 'Unknown error',
          }
        }
      })
    }
  }

  if (mergedConfig.google_ads_keyword.enabled && lead.gclid) {
    const shouldRun = await shouldEnrich(supabase, lead.id, 'google_ads_keyword')
    if (shouldRun) {
      tasks.push(async () => {
        try {
          const data = await extractGoogleAdsKeyword(lead.gclid!, lead.organization_id)
          if (!data) {
            return {
              type: 'google_ads_keyword' as const,
              status: 'skipped' as const,
              data: {},
              confidence: 0,
            }
          }
          return {
            type: 'google_ads_keyword' as const,
            status: 'success' as const,
            data: data as unknown as Record<string, unknown>,
            confidence: googleAdsKeywordConfidence(data),
          }
        } catch (err) {
          return {
            type: 'google_ads_keyword' as const,
            status: 'failed' as const,
            data: {},
            confidence: 0,
            error: err instanceof Error ? err.message : 'Unknown error',
          }
        }
      })
    }
  }

  if (mergedConfig.website_behavior.enabled) {
    const shouldRun = await shouldEnrich(supabase, lead.id, 'website_behavior')
    if (shouldRun) {
      tasks.push(async () => {
        const data = parseWebsiteBehavior(lead.custom_fields)
        if (!data) {
          return {
            type: 'website_behavior' as const,
            status: 'skipped' as const,
            data: {},
            confidence: 0,
          }
        }
        return {
          type: 'website_behavior' as const,
          status: 'success' as const,
          data: data as unknown as Record<string, unknown>,
          confidence: websiteBehaviorConfidence(),
        }
      })
    }
  }

  // Run all enrichment tasks in parallel (except credit prequal which runs after)
  const settled = await Promise.allSettled(tasks.map((t) => t()))
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      results.push(result.value)
    }
  }

  // Credit pre-qualification runs AFTER other enrichments
  // so it can use email_valid, phone_valid, etc. as inputs
  if (mergedConfig.credit_prequal.enabled) {
    const shouldRun = await shouldEnrich(supabase, lead.id, 'credit_prequal')
    if (shouldRun) {
      try {
        // Gather enrichment signals from results we just ran
        const emailResult = results.find(r => r.type === 'email_validation' && r.status === 'success')
        const phoneResult = results.find(r => r.type === 'phone_validation' && r.status === 'success')
        const ipResult = results.find(r => r.type === 'ip_geolocation' && r.status === 'success')

        const prequalResult = await autoPreQualify(supabase, lead.organization_id, lead.id, {
          first_name: lead.first_name,
          last_name: lead.last_name,
          age: lead.age,
          city: lead.city,
          state: lead.state,
          zip_code: lead.zip_code,
          date_of_birth: lead.date_of_birth,
          email: lead.email,
          phone: lead.phone,
          has_dental_insurance: lead.has_dental_insurance,
          financing_interest: lead.financing_interest,
          budget_range: lead.budget_range,
          treatment_value: lead.treatment_value,
          email_valid: emailResult ? emailResult.data.status === 'valid' : lead.email_valid,
          email_disposable: emailResult ? emailResult.data.disposable === true : null,
          phone_valid: phoneResult ? phoneResult.data.valid === true : lead.phone_valid,
          phone_line_type: (phoneResult?.data.line_type as string) || lead.phone_line_type,
          ip_is_proxy: ipResult ? (ipResult.data.is_proxy === true || ipResult.data.is_vpn === true) : null,
          distance_to_practice_miles: ipResult ? (ipResult.data.distance_to_practice_miles as number) : lead.distance_to_practice_miles,
        })

        results.push({
          type: 'credit_prequal',
          status: 'success',
          data: prequalResult as unknown as Record<string, unknown>,
          confidence: preQualConfidence(prequalResult),
        })
      } catch (err) {
        results.push({
          type: 'credit_prequal',
          status: 'failed',
          data: {},
          confidence: 0,
          error: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }
  }

  // Store enrichment results in database
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ENRICHMENT_TTL_DAYS * 24 * 60 * 60 * 1000)

  for (const result of results) {
    await supabase.from('lead_enrichment').insert({
      organization_id: lead.organization_id,
      lead_id: lead.id,
      enrichment_type: result.type,
      enrichment_source: ENRICHMENT_SOURCES[result.type],
      status: result.status,
      data: result.data,
      error_message: result.error || null,
      confidence_score: result.confidence,
      enriched_at: now.toISOString(),
      expires_at: result.status === 'success' ? expiresAt.toISOString() : null,
    })
  }

  // Build summary and compute score
  const summary = await getEnrichmentSummary(supabase, lead.id)
  const enrichmentScore = summary ? computeEnrichmentScore(summary) : 0

  // Update derived fields on the lead
  const successResults = results.filter((r) => r.status === 'success')
  const failedResults = results.filter((r) => r.status === 'failed')

  let enrichmentStatus: string
  if (successResults.length === 0 && failedResults.length > 0) {
    enrichmentStatus = 'failed'
  } else if (successResults.length > 0 && tasks.length > successResults.length) {
    enrichmentStatus = 'partial'
  } else if (successResults.length > 0) {
    enrichmentStatus = 'complete'
  } else {
    enrichmentStatus = 'pending'
  }

  const updateData: Record<string, unknown> = {
    enrichment_score: enrichmentScore,
    enrichment_status: enrichmentStatus,
    enriched_at: now.toISOString(),
  }

  // Set derived fields from specific enrichment results
  const emailResult = results.find((r) => r.type === 'email_validation' && r.status === 'success')
  if (emailResult) {
    updateData.email_valid = emailResult.data.status === 'valid'
  }

  const phoneResult = results.find((r) => r.type === 'phone_validation' && r.status === 'success')
  if (phoneResult) {
    updateData.phone_valid = phoneResult.data.valid
    updateData.phone_line_type = phoneResult.data.line_type
  }

  const ipResult = results.find((r) => r.type === 'ip_geolocation' && r.status === 'success')
  if (ipResult) {
    updateData.ip_city = ipResult.data.city
    updateData.ip_region = ipResult.data.region
    updateData.ip_country = ipResult.data.country
    updateData.distance_to_practice_miles = ipResult.data.distance_to_practice_miles
  }

  await supabase.from('leads').update(updateData).eq('id', lead.id)

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: lead.organization_id,
    lead_id: lead.id,
    activity_type: 'enriched',
    title: `Lead enriched (${successResults.length} sources, score: ${enrichmentScore}/100)`,
    description: `Enrichment providers: ${results.map((r) => `${r.type}:${r.status}`).join(', ')}`,
    metadata: {
      enrichment_score: enrichmentScore,
      providers: results.map((r) => ({ type: r.type, status: r.status, confidence: r.confidence })),
    },
  })

  return {
    enrichments: results.map((r) => ({ type: r.type, status: r.status })),
    summary: summary || buildEmptySummary(),
    enrichment_score: enrichmentScore,
  }
}

/**
 * Check if a lead should be enriched for a given type.
 * Returns false if valid non-expired enrichment already exists.
 */
export async function shouldEnrich(
  supabase: SupabaseClient,
  leadId: string,
  type: EnrichmentType
): Promise<boolean> {
  const { data } = await supabase
    .from('lead_enrichment')
    .select('id')
    .eq('lead_id', leadId)
    .eq('enrichment_type', type)
    .eq('status', 'success')
    .gt('expires_at', new Date().toISOString())
    .limit(1)

  return !data || data.length === 0
}

/**
 * Build an enrichment summary from all successful enrichments for a lead.
 */
export async function getEnrichmentSummary(
  supabase: SupabaseClient,
  leadId: string
): Promise<EnrichmentSummary | null> {
  const { data: enrichments } = await supabase
    .from('lead_enrichment')
    .select('enrichment_type, data, confidence_score')
    .eq('lead_id', leadId)
    .eq('status', 'success')
    .order('enriched_at', { ascending: false })

  if (!enrichments || enrichments.length === 0) return null

  const summary = buildEmptySummary()

  for (const e of enrichments) {
    const data = e.data as Record<string, unknown>

    switch (e.enrichment_type) {
      case 'email_validation':
        summary.email_valid = data.status === 'valid'
        summary.email_disposable = data.disposable === true
        summary.email_free = data.free_email === true
        break

      case 'phone_validation':
        summary.phone_valid = data.valid === true
        summary.phone_line_type = data.line_type as string || null
        break

      case 'ip_geolocation':
        summary.ip_is_proxy = data.is_proxy === true || data.is_vpn === true
        summary.distance_to_practice_miles = data.distance_to_practice_miles as number | null
        // Consider "match" if within 100 miles
        if (typeof data.distance_to_practice_miles === 'number') {
          summary.ip_location_match = data.distance_to_practice_miles <= 100
        }
        break

      case 'google_ads_keyword':
        summary.search_keyword = data.keyword as string || null
        break

      case 'website_behavior':
        summary.pricing_page_viewed = data.pricing_page_viewed === true
        summary.financing_page_viewed = data.financing_page_viewed === true
        summary.time_on_site_seconds = data.time_on_site_seconds as number || null
        summary.session_count = data.session_count as number || null
        break
    }
  }

  summary.enrichment_score = computeEnrichmentScore(summary)
  summary.identity_confidence = computeIdentityConfidence(summary)

  return summary
}

/**
 * Compute a composite enrichment score (0-100) from enrichment signals.
 */
export function computeEnrichmentScore(summary: EnrichmentSummary): number {
  let score = 0

  // Email validation (max 25 points)
  if (summary.email_valid === true) {
    score += summary.email_disposable ? 10 : 25
  } else if (summary.email_valid === false) {
    score += 0
  }

  // Phone validation (max 25 points)
  if (summary.phone_valid === true) {
    if (summary.phone_line_type === 'mobile') score += 25
    else if (summary.phone_line_type === 'landline') score += 18
    else if (summary.phone_line_type === 'voip') score += 10
    else score += 15
  }

  // IP geolocation (max 20 points)
  if (summary.ip_location_match === true) score += 20
  else if (summary.ip_location_match === false) score += 5
  if (summary.ip_is_proxy) score -= 10

  // Website behavior (max 20 points)
  if (summary.pricing_page_viewed) score += 10
  if (summary.financing_page_viewed) score += 5
  if (summary.time_on_site_seconds && summary.time_on_site_seconds > 120) score += 5

  // Search keyword (max 10 points)
  if (summary.search_keyword) score += 10

  return Math.max(0, Math.min(100, score))
}

function computeIdentityConfidence(summary: EnrichmentSummary): number {
  let confidence = 0

  if (summary.email_valid === true && !summary.email_disposable) confidence += 35
  else if (summary.email_valid === true) confidence += 15

  if (summary.phone_valid === true) {
    if (summary.phone_line_type === 'mobile') confidence += 35
    else confidence += 25
  }

  if (summary.ip_location_match === true) confidence += 20
  else if (summary.ip_is_proxy) confidence -= 10

  if (summary.session_count && summary.session_count > 1) confidence += 10

  return Math.max(0, Math.min(100, confidence))
}

function buildEmptySummary(): EnrichmentSummary {
  return {
    email_valid: null,
    email_disposable: null,
    email_free: null,
    phone_valid: null,
    phone_line_type: null,
    ip_location_match: null,
    ip_is_proxy: null,
    distance_to_practice_miles: null,
    search_keyword: null,
    pricing_page_viewed: null,
    financing_page_viewed: null,
    time_on_site_seconds: null,
    session_count: null,
    enrichment_score: 0,
    identity_confidence: 0,
  }
}
