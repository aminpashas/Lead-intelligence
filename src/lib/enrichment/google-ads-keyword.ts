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

/**
 * Extract keyword data from a Google Click ID (gclid).
 *
 * Returns null if:
 * - No gclid provided
 * - Organization has no Google Ads credentials configured
 * - Google Ads API is not yet integrated (Phase 1)
 */
export async function extractGoogleAdsKeyword(
  gclid: string,
  _organizationId: string
): Promise<GoogleAdsKeywordResult | null> {
  if (!gclid) return null

  // Phase 1: Parse what we can from UTM params stored on the lead.
  // Full Google Ads API integration (ClickView resource) requires
  // OAuth2 refresh token per org — planned for Phase 2.
  //
  // For now, return null and let the orchestrator mark this as 'skipped'.
  // The UTM params (utm_campaign, utm_content, utm_term) on the lead
  // already capture the most useful keyword data from Google Ads.

  return null
}

export function googleAdsKeywordConfidence(result: GoogleAdsKeywordResult | null): number {
  if (!result) return 0
  if (result.keyword) return 1.0
  if (result.campaign_name) return 0.6
  return 0.3
}
