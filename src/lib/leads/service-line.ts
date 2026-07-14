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

// Implants is the DEFAULT / residual service line for this practice. GHL modelled
// each treatment as its own pipeline (AOX Nurturing Database, Full-Arch Leads, …);
// the stage reconcile folds every pipeline onto LI's shared funnel and DROPS which
// pipeline a lead came from, so the ~48k historical GHL/WhatConverts import lands
// with no treatment attribute at all. This is a full-arch implant practice — the
// niche book (TMJ/Sleep/Cosmetic/LANAP) is tiny (~1.7k) and precisely signalled —
// so a lead is an implant lead when it carries an explicit implant signal OR
// matches NO niche service. (Part 2 — serviceLineFromPipelineName + the reconcile
// stamper — additionally writes an explicit implants/… tag going forward.)
const NICHE_SERVICES = ['cosmetic', 'tmj', 'sleep_apnea', 'lanap'] as const

/**
 * The positive PostgREST conditions that select a single service line's explicit
 * signals: treatment_interest + real intake tags + campaign/UTM keywords. Shared
 * by `serviceLineOrFilter` (which additionally builds the implants residual).
 * Returns null for an unknown service key.
 */
function serviceConditions(service: string): string[] | null {
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
  // Landing-page URL — a NICHE-ONLY signal. The practice runs a dedicated domain
  // per niche DBA (tmjandsleepapneasanfrancisco.com, …), so for GMB/organic leads
  // whose UTMs carry no treatment keyword ("GMBlisting / Gmb-apt") the URL is the
  // only classification signal. Implants keywords are deliberately NOT matched
  // against URLs: 'arch' is a substring of 'search' (false positives on query
  // strings), and implants is the residual line anyway.
  if (service !== 'implants') {
    for (const kw of keywords) conds.push(`landing_page_url.ilike.%${kw}%`)
  }
  return conds
}

/**
 * PostgREST `.or()` condition string that selects the leads of a single service
 * line, server-side, over the whole book. This is the SQL twin of
 * `classifyLeadServiceLines` — the client classifier reads a lead already in
 * hand, this one filters/counts the full table without loading it. Both the
 * /leads table filter and the pipeline board's treatment chips share this so
 * their numbers agree (the old board classified only the loaded card sample,
 * which is why "All 48044" sat next to "Implants 2").
 *
 * Implants is the residual line: its filter is `<explicit implant signals> OR
 * <matches no niche signal>`. Niche services are their positive signals only.
 * Returns null for an unknown service key.
 */
export function serviceLineOrFilter(service: string): string | null {
  const conds = serviceConditions(service)
  if (!conds) return null

  if (service === 'implants') {
    // Residual: a lead is implants unless it matches a niche service. Expressed
    // as an AND of NULL-SAFE negations — a bare `not.or(ilike…)` is wrong because
    // `ilike` on a NULL column yields NULL (not false), and `NOT(NULL)` is NULL,
    // so every lead with null UTM fields (the ~48k historical book) would be
    // silently dropped. Each keyword clause is `(field is null OR field not ilike
    // …)` so a missing value reads as "not that niche".
    return [...conds, nicheExclusionGroup()].join(',')
  }
  return conds.join(',')
}

/**
 * A PostgREST `and(…)` group that is TRUE for leads matching NO niche service,
 * with explicit NULL handling on every keyword field. The SQL half of "implants
 * is the residual"; kept in lockstep with SERVICE_KEYWORDS / SERVICE_TAGS so it
 * negates exactly the same signals the niche filters select.
 */
function nicheExclusionGroup(): string {
  // landing_page_url is negated here because serviceConditions matches niche
  // keywords against it — the residual must exclude exactly what niche selects.
  const fields = ['utm_campaign', 'utm_source', 'campaign_attribution->>campaign_name', 'landing_page_url']
  const parts: string[] = []
  // treatment_interest is a single value → "not any niche interest" (null-safe).
  parts.push(
    `or(custom_fields->>treatment_interest.is.null,custom_fields->>treatment_interest.not.in.(${NICHE_SERVICES.join(',')}))`
  )
  // tags never null (defaults to []): contains none of the niche intake tags.
  const nicheTags = new Set(NICHE_SERVICES.flatMap((s) => SERVICE_TAGS[s] ?? []))
  for (const t of nicheTags) parts.push(`tags.not.cs.{"${t}"}`)
  // keyword fields are nullable → null OR not-matching counts as "not niche".
  const nicheKeywords = new Set(NICHE_SERVICES.flatMap((s) => SERVICE_KEYWORDS[s] ?? []))
  for (const kw of nicheKeywords) {
    for (const field of fields) parts.push(`or(${field}.is.null,${field}.not.ilike.%${kw}%)`)
  }
  return `and(${parts.join(',')})`
}

/**
 * Which treatment service line(s) a lead belongs to. Returns every matching
 * key — a lead can plausibly touch more than one (e.g. an "arch" campaign that
 * also mentions cosmetic). The client-side twin of `serviceLineOrFilter`; keep
 * the two in sync so the board filter and the table filter agree.
 *
 * Implants is the residual default: a lead with an explicit implant signal, OR
 * with NO niche signal at all, is an implant lead (see NICHE_SERVICES above).
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
  // Niche-only URL haystack — SQL twin: the landing_page_url conditions in
  // serviceConditions/nicheExclusionGroup. Implants keywords never match URLs
  // ('arch' ⊂ 'search'); see the comment there.
  const urlHaystack = (lead.landing_page_url ?? '').toLowerCase()

  const matches = (key: string): boolean => {
    // Explicit treatment_interest: implants store 'implant', the rest store the
    // service key verbatim (see the ingestion/onboarding writers).
    const explicit =
      key === 'implants'
        ? interest === 'implant' || interest === 'implants'
        : interest === key
    const tagged = (SERVICE_TAGS[key] ?? []).some((t) => tags.includes(t))
    const keyworded = (SERVICE_KEYWORDS[key] ?? []).some(
      (kw) => haystack.includes(kw) || (key !== 'implants' && urlHaystack.includes(kw))
    )
    return explicit || tagged || keyworded
  }

  // Niche first (order-preserving via SERVICE_LINES), then implants as either an
  // explicit match or the residual when nothing niche matched.
  const niche = SERVICE_LINES.map((s) => s.key)
    .filter((k): k is (typeof NICHE_SERVICES)[number] =>
      (NICHE_SERVICES as readonly string[]).includes(k)
    )
    .filter(matches)
  const matched: string[] = []
  if (matches('implants') || niche.length === 0) matched.push('implants')
  matched.push(...niche)
  return matched
}

// GHL pipeline-name → service-line patterns. GHL carries the treatment as the
// PIPELINE the opportunity lives in ("AOX Nurturing Database", "Full-Arch Leads",
// "TMJ", …); the stage reconcile otherwise discards it. Niche patterns are checked
// BEFORE implants so a dedicated niche pipeline wins, and implants stays the last
// (broadest) known pattern — an unrecognised pipeline returns null so the reconcile
// stamper never mislabels. Word-boundary anchored to avoid stray substring hits.
const PIPELINE_SERVICE_PATTERNS: { service: string; test: RegExp }[] = [
  { service: 'tmj', test: /\btmj\b/i },
  { service: 'sleep_apnea', test: /\b(sleep|apnea)\b/i },
  { service: 'lanap', test: /\blanap\b/i },
  { service: 'cosmetic', test: /\b(veneers?|cosmetic|makeover)\b/i },
  { service: 'implants', test: /\b(aox|ao4|all[-\s]?on[-\s]?\d?|full[-\s]?arch|implants?|arch)\b/i },
]

/**
 * Derive the canonical service-line key from a GHL pipeline name, or null when
 * the name matches no known treatment. Used by the reconcile stamper (Part 2) to
 * write an explicit service tag onto each matched lead so the historical book
 * gains precise treatment attribution going forward.
 */
export function serviceLineFromPipelineName(name: string | null | undefined): string | null {
  if (!name) return null
  for (const { service, test } of PIPELINE_SERVICE_PATTERNS) {
    if (test.test(name)) return service
  }
  return null
}

/**
 * The tag the reconcile stamper writes for a service line — the canonical key,
 * which both `serviceConditions` (via SERVICE_TAGS) and `classifyLeadServiceLines`
 * already recognise. Returns null for an unknown service.
 */
export function serviceLineTag(service: string): string | null {
  return SERVICE_KEYWORDS[service] ? service : null
}

// Priority when intake signals match more than one niche: the TMJ + sleep-apnea
// DBA shares one domain (tmjandsleepapneasanfrancisco.com matches both 'tmj'
// and 'sleep'), so the more specific form message is scanned FIRST and breaks
// the tie (contact-us-tmj → tmj). Mirrors BRAND_SERVICE_PRIORITY's niche order.
const INTAKE_SIGNAL_PRIORITY = ['tmj', 'sleep_apnea', 'lanap', 'cosmetic'] as const

/**
 * Derive a NICHE service line from what a bridged/organic intake actually
 * carries: the form message ("contact-us-tmj") and the landing-page URL
 * (per-DBA domains). Used by the ingest stamper to write an explicit
 * `treatment_interest` + canonical tag at insert, so downstream consumers
 * (alerts, Slack routing, brand resolution, filters) never fall through to
 * the implants residual on a clearly-signalled niche lead.
 *
 * Message wins over URL (it names the specific form on a shared-domain DBA).
 * Never returns 'implants' — implants stays the residual, and its keywords are
 * unsafe on free text/URLs ('arch' ⊂ 'search'). Returns null when nothing
 * niche is signalled.
 */
export function serviceLineFromIntakeSignals(input: {
  landingPageUrl?: string | null
  message?: string | null
}): string | null {
  const scan = (text: string | null | undefined): string | null => {
    const t = (text ?? '').toLowerCase()
    if (!t) return null
    for (const service of INTAKE_SIGNAL_PRIORITY) {
      if ((SERVICE_KEYWORDS[service] ?? []).some((kw) => t.includes(kw))) return service
    }
    return null
  }
  return scan(input.message) ?? scan(input.landingPageUrl)
}
