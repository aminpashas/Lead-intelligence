/**
 * UTM → channel fallback classifier.
 *
 * The authoritative channel resolution lives UPSTREAM in Dion Growth Studio
 * (click-id + campaign matching), pushed to LI as `campaign_attribution.channel`
 * via the /api/v1/leads bridge. But DGS's resolver has blind spots — some
 * WhatConverts source labels it doesn't recognise ("SEO - SF", "GMBlisting",
 * "TMJ GMB Number", ...) arrive with NO channel. Those leads then fall out of
 * every channel-segmented view, landing in a `null` bucket (this was the gap
 * surfaced by the Meta/Google acquisition audit).
 *
 * This is the LAST-RESORT net: when a bridged lead carries no DGS-resolved
 * channel, derive one from the flat utm/click-id fields the bridge already
 * receives. It is deliberately LOW confidence (`FALLBACK_CONFIDENCE`, well below
 * DGS's 0.85–1.0) so that a later DGS re-sync always overrides the guess via
 * `mergeAttributionOnDedup`. Channel codes match the DGS `metrics_daily`
 * convention in `attribution.ts` (ppc_google, seo_gmb, social_fb, ...).
 *
 * Design bias: recover the obvious cases, NEVER guess a paid channel from a
 * weak signal (a bare `utm_source=facebook` with no medium is organic social,
 * not an ad) so the paid-ad "new leads" KPI can't be inflated. Non-empty but
 * unrecognised labels (call-tracking numbers, brochure names) stay unresolved.
 */

export interface UtmSignals {
  utm_source?: string | null
  utm_medium?: string | null
  utm_campaign?: string | null
  gclid?: string | null
  fbclid?: string | null
}

export interface ClassifiedChannel {
  channel: string
  confidence: number
}

/**
 * Confidence stamped on a utm-derived channel. MUST stay below DGS's resolved
 * confidence (>= 0.85) so a genuine DGS resolution always wins on re-sync.
 */
export const FALLBACK_CONFIDENCE = 0.4

// Analytics placeholders that mean "no value" — treated as empty.
const PLACEHOLDER = new Set([
  '', '(none)', '(not set)', '(notset)', 'none', 'not set', 'unknown', 'null', 'undefined',
])

function norm(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase()
}

// Lower-cased value with analytics placeholders collapsed to ''. `(direct)` is
// intentionally NOT a placeholder — it is a positive "direct" signal.
function clean(v: string | null | undefined): string {
  const n = norm(v)
  return PLACEHOLDER.has(n) ? '' : n
}

const PAID_MEDIUM = /(cpc|ppc|paid[\s_-]?search|paid[\s_-]?social|paid[\s_-]?media|^paid$|[\s_-]paid([\s_-]|$))/
const SEARCH_ENGINE = /(google|bing|yahoo|duckduckgo|ecosia|baidu|yandex|aol)/
const AI_SOURCE = /(chatgpt|chat\.openai|openai|perplexity|gemini|copilot|\bclaude\b|you\.com)/
const META_SOURCE = /(facebook|instagram|\bmeta\b|\bfb\b|\big\b|fb[_-]?ad)/

/**
 * Best-effort channel from utm signals, or null when there is no safe call.
 * Rules are ordered by specificity — the first match wins.
 */
export function classifyChannelFromUtm(s: UtmSignals): ClassifiedChannel | null {
  const source = clean(s.utm_source)
  const medium = clean(s.utm_medium)
  const campaign = clean(s.utm_campaign)
  const hasGclid = !!clean(s.gclid)
  const hasFbclid = !!clean(s.fbclid)
  const paidMedium = PAID_MEDIUM.test(medium)
  const hay = `${source} ${campaign}`
  const hit = (channel: string): ClassifiedChannel => ({ channel, confidence: FALLBACK_CONFIDENCE })

  // --- Paid search / social. gclid is set ONLY on paid Google clicks, so it is
  //     an unambiguous ppc_google signal even when DGS missed it. Otherwise a
  //     paid medium plus a matching platform source is required. ---
  if (hasGclid) return hit('ppc_google')
  if (paidMedium && /google/.test(source)) return hit('ppc_google')
  if (paidMedium && META_SOURCE.test(source)) return hit('ppc_meta')

  // --- Google Business Profile (check before generic organic search). ---
  if (/(gmb|google\s?business|business\s?profile|googlemybusiness)/.test(hay)) return hit('seo_gmb')

  // --- AI assistants. ---
  if (AI_SOURCE.test(source)) return hit('seo_ai')

  // --- Organic search: an explicit organic medium, an "SEO ..." label, or a
  //     known search engine with no paid signal. ---
  if (medium === 'organic' || source.startsWith('seo') || (SEARCH_ENGINE.test(source) && !paidMedium)) {
    return hit('seo_organic')
  }

  // --- Organic social. ---
  if (/(facebook|m\.facebook|\bfb\b)/.test(source)) return hit('social_fb')
  if (/instagram|\big\b/.test(source)) return hit('social_ig')
  if (/yelp/.test(source)) return hit('social_yelp')
  if (/nextdoor/.test(source)) return hit('social_nextdoor')
  if (/reddit/.test(source)) return hit('social_reddit')
  if (/youtube/.test(source)) return hit('social_youtube')

  // --- Referral: explicit referral medium, a "referral" token in the source or
  //     campaign (doctor-referral web forms arrive as utm_source=doctor_referral
  //     / utm_campaign=doctor_referral_form, often with medium="Direct traffic" —
  //     DGS mislabels those `direct`), or a bare domain as the source. ---
  if (
    medium === 'referral' ||
    /referr/.test(hay) ||
    (/\.[a-z]{2,}(\/|$)/.test(source) && !SEARCH_ENGINE.test(source))
  ) {
    return hit('referral')
  }

  // --- Direct: explicit direct token, or genuinely no usable signal. ---
  if (source === '(direct)' || source === 'direct' || (!source && !medium && !campaign && !hasFbclid)) {
    return hit('direct')
  }

  // Non-empty but unrecognised (call-tracking-number labels, brochure names) —
  // leave for DGS/human rather than guessing wrong.
  return null
}

/**
 * Reconcile an incoming DGS attribution with the utm fallback classifier. DGS
 * is authoritative when it resolves a channel confidently, but two cases warrant
 * a utm-derived correction:
 *
 *  1. NO channel — DGS's resolver missed it entirely; fill from utm (existing
 *     behavior). Confidence/source_system already on the blob are preserved.
 *  2. Low-confidence `direct` (<= FALLBACK_CONFIDENCE) — DGS's ambiguous
 *     catch-all when it couldn't tie a click to a campaign. If the flat utm
 *     signals name something more specific (e.g. a doctor referral DGS keyed to
 *     `direct` off utm_medium="Direct traffic"), prefer that. Stamped
 *     `li_utm_override` at FALLBACK_CONFIDENCE, so a genuine DGS re-sync (>=0.85)
 *     still wins later via mergeAttributionOnDedup.
 *
 * A confidently-resolved channel (anything not weak `direct`) is never touched.
 * Returns the attribution to store (possibly the same object).
 */
export function reconcileChannel(
  attribution: Record<string, string | number> | null,
  utm: UtmSignals,
): Record<string, string | number> | null {
  const channel = attribution?.channel
  const conf = Number(attribution?.attribution_confidence ?? 0)
  const missing = !channel
  const weakDirect = channel === 'direct' && conf <= FALLBACK_CONFIDENCE
  if (!missing && !weakDirect) return attribution

  const fb = classifyChannelFromUtm(utm)
  // Nothing better to offer, or the override wouldn't change the channel.
  if (!fb || (weakDirect && fb.channel === 'direct')) return attribution

  return {
    ...(attribution ?? {}),
    channel: fb.channel,
    attribution_confidence: missing
      ? (attribution?.attribution_confidence ?? fb.confidence)
      : fb.confidence,
    source_system: missing
      ? ((attribution?.source_system as string) ?? 'li_utm_fallback')
      : 'li_utm_override',
  }
}
