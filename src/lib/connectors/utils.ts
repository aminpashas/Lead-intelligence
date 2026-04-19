/**
 * Connector Utilities
 *
 * Shared helper functions used across all connectors.
 */

import { createHmac, createHash } from 'crypto'

/**
 * SHA256 hash a value for privacy-safe matching (Meta CAPI, Google Enhanced Conversions).
 * Normalizes input: trims whitespace and lowercases before hashing.
 */
export function hashForMatching(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex')
}

/**
 * Generate an HMAC-SHA256 signature for outbound webhook payloads.
 */
export function hmacSign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

/**
 * Safe JSON parse that returns null instead of throwing.
 */
export function safeJsonParse<T = unknown>(str: string): T | null {
  try {
    return JSON.parse(str) as T
  } catch {
    return null
  }
}
