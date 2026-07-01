/**
 * Google Ads Keyword Extraction
 *
 * Resolves gclid to campaign/keyword data. Requires per-org Google Ads
 * API credentials stored in organization settings.
 *
 * Phase 1: Stub implementation. Full Google Ads API integration planned
 * for Phase 2 when OAuth2 refresh token flow is built.
 */

import type { GoogleAdsKeywordResult } from './types'

export type LeadUtm = {
  term?: string | null
  campaign?: string | null
  content?: string | null
}

/**
 * Derive keyword/campaign signal from the UTM params captured on the lead at
 * click time. `utm_term` IS the Google Ads search keyword for search campaigns,
 * so this gives real behavioral-intent signal without the Google Ads API.
 * Pure + testable. Returns null when there's no usable UTM signal.
 */
export function deriveKeywordFromUtm(utm?: LeadUtm | null): GoogleAdsKeywordResult | null {
  const keyword = utm?.term?.trim() || null
  const campaign_name = utm?.campaign?.trim() || null
  const ad_group_name = utm?.content?.trim() || null
  if (!keyword && !campaign_name && !ad_group_name) return null
  return { campaign_name, ad_group_name, keyword, match_type: null, device: null }
}

/**
 * Extract keyword data for a Google Click ID (gclid).
 *
 * Until the full Google Ads ClickView API integration lands (needs a per-org
 * OAuth2 refresh token), this derives the most useful signal from the lead's
 * UTM params. Previously it always returned null — a hardcoded stub — so the
 * behavioral_intent scoring dimension got no keyword signal at all.
 */
export async function extractGoogleAdsKeyword(
  gclid: string,
  _organizationId: string,
  utm?: LeadUtm | null
): Promise<GoogleAdsKeywordResult | null> {
  if (!gclid) return null
  return deriveKeywordFromUtm(utm)
}

export function googleAdsKeywordConfidence(result: GoogleAdsKeywordResult | null): number {
  if (!result) return 0
  if (result.keyword) return 1.0
  if (result.campaign_name) return 0.6
  return 0.3
}
