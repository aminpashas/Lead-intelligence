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

// Tag tokens that signal a service line. Critically, the historical book tags
// leads by their intake SOURCE LINE and campaign — NOT by the canonical service
// key — so the obvious `tags.includes('tmj')` matches almost nothing. In this
// practice's real data, TMJ leads carry `src:tmj` (~1.3k) and full-arch implant
// leads carry `full-arch-cold` (~0.5k); matching these ~doubles the Implants
// count (339 → 621) and is the difference between the chips working and not.
// New ad leads additionally carry the canonical key (`implants`, `tmj`, …).
//
// Both the SQL filter (serviceLineOrFilter) and the client classifier
// (classifyLeadServiceLines) read this list, so the /leads table, the pipeline
// chips, and the /closing board all agree. Values may contain hyphens/colons —
// safe inside a double-quoted PostgREST `tags.cs.{"…"}` containment test.
export const SERVICE_TAGS: Record<string, string[]> = {
  implants: ['implants', 'implant', 'full-arch-cold'],
  cosmetic: ['cosmetic', 'veneers'],
  tmj: ['tmj', 'src:tmj'],
  sleep_apnea: ['sleep_apnea', 'src:sleep'],
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
 * PostgREST `.or()` condition string that selects the leads of a single service
 * line, server-side, over the whole book. This is the SQL twin of
 * `classifyLeadServiceLines` — the client classifier reads a lead already in
 * hand, this one filters/counts the full table without loading it. Both the
 * /leads table filter and the pipeline board's treatment chips share this so
 * their numbers agree (the old board classified only the loaded card sample,
 * which is why "All 48044" sat next to "Implants 2").
 *
 * Returns null for an unknown service key. Mirrors the explicit-signal +
 * keyword-fallback structure of the classifier; note cosmetic/lanap have no
 * explicit tag/interest writer yet, so they match on keywords only.
 */
export function serviceLineOrFilter(service: string): string | null {
  const keywords = SERVICE_KEYWORDS[service]
  if (!keywords) return null

  const conds: string[] = []
  // Explicit treatment_interest carried by new ad leads: implants store
  // 'implant', every other service stores its key verbatim.
  conds.push(`custom_fields->>treatment_interest.eq.${service === 'implants' ? 'implant' : service}`)
  // Tag signals — canonical key + this book's real intake tags (src:tmj,
  // full-arch-cold). Double-quote so hyphens/colons can't break `.or()` parsing.
  for (const tag of SERVICE_TAGS[service] ?? []) conds.push(`tags.cs.{"${tag}"}`)
  for (const kw of keywords) {
    for (const field of ['utm_campaign', 'utm_source', 'campaign_attribution->>campaign_name']) {
      conds.push(`${field}.ilike.%${kw}%`)
    }
  }
  return conds.join(',')
}

/**
 * Which treatment service line(s) a lead belongs to. Returns every matching
 * key — a lead can plausibly touch more than one (e.g. an "arch" campaign that
 * also mentions cosmetic). The client-side twin of `serviceLineOrFilter`; keep
 * the two in sync so the board filter and the table filter agree.
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
    const tagged = (SERVICE_TAGS[key] ?? []).some((t) => tags.includes(t))
    const keyworded = SERVICE_KEYWORDS[key].some((kw) => haystack.includes(kw))
    if (explicit || tagged || keyworded) matched.push(key)
  }
  return matched
}
