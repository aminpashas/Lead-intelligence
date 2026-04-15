/**
 * Lender API Base URL Validation
 *
 * API-5: Prevents SSRF attacks where a malicious admin sets api_base_url
 * to their own server, causing the system to POST SSNs to an attacker.
 *
 * Each lender has a hardcoded allowlist of valid API domains.
 */

import type { LenderSlug } from './types'

const ALLOWED_DOMAINS: Record<string, string[]> = {
  carecredit: [
    'api.syf.com',
    'api-stg.syf.com',
    'api-uat.syf.com',
  ],
  sunbit: [
    'api.sunbit.com',
    'api-sandbox.sunbit.com',
    'sandbox.sunbit.com',
  ],
  affirm: [
    'api.affirm.com',
    'sandbox.affirm.com',
  ],
}

/**
 * Validate that a lender's API base URL is on the approved domain list.
 * Throws if the URL domain is not recognized for the lender.
 *
 * @param lenderSlug - The lender identifier
 * @param baseUrl - The API base URL to validate (e.g., "https://api.syf.com")
 * @returns The validated URL (unchanged)
 * @throws Error if the domain is not in the allowlist
 */
export function validateLenderBaseUrl(lenderSlug: LenderSlug, baseUrl: string): string {
  const allowedDomains = ALLOWED_DOMAINS[lenderSlug]

  // Link-based lenders don't have API base URLs to validate
  if (!allowedDomains) return baseUrl

  try {
    const url = new URL(baseUrl)

    // Must be HTTPS
    if (url.protocol !== 'https:') {
      throw new Error(`${lenderSlug} API base URL must use HTTPS`)
    }

    // Domain must be in the allowlist
    if (!allowedDomains.includes(url.hostname)) {
      throw new Error(
        `Invalid ${lenderSlug} API domain: ${url.hostname}. ` +
        `Allowed domains: ${allowedDomains.join(', ')}`
      )
    }

    // Strip trailing slash for consistency
    return baseUrl.replace(/\/+$/, '')
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(`Invalid ${lenderSlug} API base URL: ${baseUrl}`)
    }
    throw err
  }
}
