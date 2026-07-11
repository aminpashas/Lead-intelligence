import type { Lead } from '@/types/database'
import { SERVICE_TAGS, SERVICE_KEYWORDS } from '@/lib/leads/service-line'
import type { Branding, BrandLogistics } from '@/lib/branding/schema'

export type ResolvedBrand = {
  practiceName: string
  doctorName: string | null
  website: string | null
  logistics: BrandLogistics
}

// Branding priority when a lead matches more than one line. The niche medical
// brands (their own name + doctor) win over implants; cosmetic/lanap map to the
// general brand anyway so their order only matters relative to each other.
const BRAND_SERVICE_PRIORITY = ['tmj', 'sleep_apnea', 'implants', 'cosmetic', 'lanap'] as const

/** Explicit-signal-only detection — unlike classifyLeadServiceLines this NEVER
 *  falls back to implants. Returns the highest-priority explicitly-signalled
 *  service line, or null. An explicit `serviceLine` (e.g. campaigns.service_line)
 *  short-circuits detection. */
export function resolveBrandServiceLine(input: {
  serviceLine?: string | null
  lead?: Lead | null
}): string | null {
  if (input.serviceLine && input.serviceLine.trim()) return input.serviceLine.trim()
  const lead = input.lead
  if (!lead) return null

  const interest = String((lead.custom_fields?.treatment_interest as string | undefined) ?? '').toLowerCase()
  const tags = (lead.tags ?? []).map((t) => t.toLowerCase())
  const haystack = [lead.utm_campaign, lead.utm_source, lead.campaign_attribution?.campaign_name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  const matchesExplicit = (key: string): boolean => {
    const explicit = key === 'implants'
      ? interest === 'implant' || interest === 'implants'
      : interest === key
    const tagged = (SERVICE_TAGS[key] ?? []).some((t) => tags.includes(t))
    const keyworded = (SERVICE_KEYWORDS[key] ?? []).some((kw) => haystack.includes(kw))
    return explicit || tagged || keyworded
  }

  for (const key of BRAND_SERVICE_PRIORITY) if (matchesExplicit(key)) return key
  return null
}

/** Resolve the brand for a given (already-decided) service line. Falls back to
 *  orgName when the mapped brand has no name entered yet. */
export function resolveBrand(
  branding: Branding,
  serviceLine: string | null,
  orgName: string
): ResolvedBrand {
  const slug = (serviceLine && branding.serviceLineToBrand[serviceLine]) || branding.defaultBrand
  const brand = branding.brands[slug]
  const name = (brand?.name?.trim()) || (orgName?.trim()) || 'our practice'
  const doctorName = brand?.doctorName?.trim() || null
  const website = brand?.website?.trim() || null
  return { practiceName: name, doctorName, website, logistics: branding.logistics }
}

/** Convenience: detect the service line from context, then resolve the brand. */
export function resolveBrandForContext(
  branding: Branding,
  orgName: string,
  ctx: { serviceLine?: string | null; lead?: Lead | null }
): ResolvedBrand {
  return resolveBrand(branding, resolveBrandServiceLine(ctx), orgName)
}
