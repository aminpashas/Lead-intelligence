/**
 * Website Behavioral Tracking Parser
 *
 * Parses behavioral signals captured by client-side JavaScript
 * and passed through webhook custom_fields.
 *
 * Expected custom_fields keys (prefixed with underscore to avoid collisions):
 * - _pages_visited: string[] — URL paths visited
 * - _time_on_site: number — seconds on site
 * - _pricing_viewed: boolean — visited pricing/cost page
 * - _financing_viewed: boolean — visited financing page
 * - _testimonials_viewed: boolean — viewed testimonials/reviews
 * - _before_after_viewed: boolean — viewed before/after gallery
 * - _device_type: string — desktop/mobile/tablet
 * - _browser: string — browser name
 * - _session_count: number — total sessions
 * - _form_time: number — seconds to complete form
 */

import type { WebsiteBehaviorResult } from './types'

export function parseWebsiteBehavior(
  customFields: Record<string, unknown> | null | undefined
): WebsiteBehaviorResult | null {
  if (!customFields) return null

  // Check if any behavioral tracking fields exist
  const hasAnyField = Object.keys(customFields).some((k) => k.startsWith('_'))
  if (!hasAnyField) return null

  const pagesVisited = Array.isArray(customFields._pages_visited)
    ? (customFields._pages_visited as string[])
    : []

  const timeOnSite = typeof customFields._time_on_site === 'number'
    ? customFields._time_on_site
    : 0

  // Auto-detect pricing/financing pages from URLs if not explicitly flagged
  const pricingViewed =
    customFields._pricing_viewed === true ||
    pagesVisited.some((p) => /pric|cost|fee|how.much|invest/i.test(p))

  const financingViewed =
    customFields._financing_viewed === true ||
    pagesVisited.some((p) => /financ|payment.plan|afford|credit/i.test(p))

  const testimonialsViewed =
    customFields._testimonials_viewed === true ||
    pagesVisited.some((p) => /testimoni|review|patient.stor/i.test(p))

  const beforeAfterViewed =
    customFields._before_after_viewed === true ||
    pagesVisited.some((p) => /before.after|gallery|result|transform/i.test(p))

  const rawDeviceType = String(customFields._device_type || '').toLowerCase()
  let deviceType: WebsiteBehaviorResult['device_type'] = 'desktop'
  if (rawDeviceType === 'mobile' || rawDeviceType === 'phone') deviceType = 'mobile'
  else if (rawDeviceType === 'tablet') deviceType = 'tablet'

  return {
    pages_visited: pagesVisited,
    time_on_site_seconds: timeOnSite,
    pricing_page_viewed: pricingViewed,
    financing_page_viewed: financingViewed,
    testimonials_viewed: testimonialsViewed,
    before_after_viewed: beforeAfterViewed,
    device_type: deviceType,
    browser: typeof customFields._browser === 'string' ? customFields._browser : null,
    session_count: typeof customFields._session_count === 'number' ? customFields._session_count : 1,
    form_time_seconds: typeof customFields._form_time === 'number' ? customFields._form_time : null,
  }
}

export function websiteBehaviorConfidence(): number {
  return 1.0 // First-party data is always high confidence
}
