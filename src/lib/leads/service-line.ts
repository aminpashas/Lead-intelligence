import type { Lead } from '@/types/database'

// Single source of truth for service-line (treatment) classification.
//
// GHL models each treatment as its own pipeline; LI keeps ONE funnel and
// treats the treatment as a filterable attribute of the lead. New ad leads
// carry an explicit `custom_fields.treatment_interest` (+ a tag), but the
// historical book (45k GHL/WhatConverts imports) has no such field — it's
// only classifiable from campaign/UTM keywords. So every service matches
// both an explicit signal and a keyword fallback.
//
// Keep the keyword list to SINGLE words: multi-word values break PostgREST
// `.or()` parsing in the server-side /leads filter that shares this map.
export const SERVICE_KEYWORDS: Record<string, string[]> = {
  implants: ['implant', 'ao4', 'aox', 'arch'],
  cosmetic: ['veneer', 'cosmetic', 'makeover'],
  tmj: ['tmj'],
  sleep_apnea: ['sleep'],
  lanap: ['lanap'],
}

// Display order + human labels for the filter UI. Order is intentional:
// implants first (highest volume / value), niche services after.
export const SERVICE_LINES: { key: string; label: string }[] = [
  { key: 'implants', label: 'Implants' },
  { key: 'cosmetic', label: 'Cosmetic' },
  { key: 'tmj', label: 'TMJ' },
  { key: 'sleep_apnea', label: 'Sleep Apnea' },
  { key: 'lanap', label: 'LANAP' },
]

/**
 * Which treatment service line(s) a lead belongs to. Returns every matching
 * key — a lead can plausibly touch more than one (e.g. an "arch" campaign that
 * also mentions cosmetic). Mirrors the SQL conditions in /leads/page.tsx so the
 * board filter and the table filter agree.
 */
export function classifyLeadServiceLines(lead: Lead): string[] {
  const interest = String(
    (lead.custom_fields?.treatment_interest as string | undefined) ?? ''
  ).toLowerCase()
  const tags = (lead.tags ?? []).map((t) => t.toLowerCase())
  const haystack = [
    lead.utm_campaign,
    lead.utm_source,
    lead.campaign_attribution?.campaign_name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  const matched: string[] = []
  for (const { key } of SERVICE_LINES) {
    // Explicit treatment_interest: implants store 'implant', the rest store the
    // service key verbatim (see the ingestion/onboarding writers).
    const explicit =
      key === 'implants'
        ? interest === 'implant' || interest === 'implants'
        : interest === key
    const tagged = tags.includes(key)
    const keyworded = SERVICE_KEYWORDS[key].some((kw) => haystack.includes(kw))
    if (explicit || tagged || keyworded) matched.push(key)
  }
  return matched
}
