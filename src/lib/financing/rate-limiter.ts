/**
 * Simple in-memory rate limiter for financing endpoints.
 * 
 * SEC-5: Prevents abuse of /api/financing/apply — without this,
 * an attacker can trigger mass hard credit pulls on victims.
 *
 * In serverless (Vercel), this is per-instance. For production,
 * consider using Redis-backed rate limiting (e.g., @upstash/ratelimit).
 * This provides a reasonable first layer of defense.
 */

type RateLimitEntry = {
  count: number
  resetAt: number
}

const store = new Map<string, RateLimitEntry>()

// Cleanup stale entries every 5 minutes to prevent memory leaks
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) {
      store.delete(key)
    }
  }
}, 5 * 60 * 1000)

export type RateLimitConfig = {
  /** Maximum requests allowed in the window */
  maxRequests: number
  /** Window size in milliseconds */
  windowMs: number
}

export type RateLimitResult = {
  allowed: boolean
  remaining: number
  resetAt: number
}

/**
 * Check rate limit for a given key.
 * Returns whether the request is allowed.
 */
export function checkRateLimit(key: string, config: RateLimitConfig): RateLimitResult {
  const now = Date.now()
  const existing = store.get(key)

  if (!existing || existing.resetAt < now) {
    // New window
    const entry: RateLimitEntry = {
      count: 1,
      resetAt: now + config.windowMs,
    }
    store.set(key, entry)
    return { allowed: true, remaining: config.maxRequests - 1, resetAt: entry.resetAt }
  }

  if (existing.count >= config.maxRequests) {
    return { allowed: false, remaining: 0, resetAt: existing.resetAt }
  }

  existing.count++
  return { allowed: true, remaining: config.maxRequests - existing.count, resetAt: existing.resetAt }
}

// ── Preset configs ────────────────────────────────────────────────

/** Per-IP rate limit for the public financing application endpoint */
export const FINANCING_APPLY_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 5,
  windowMs: 60 * 60 * 1000, // 5 per hour per IP
}

/** Per-share-token rate limit (1 submission per token) */
export const FINANCING_TOKEN_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 1,
  windowMs: 24 * 60 * 60 * 1000, // 1 per 24 hours per token
}

/** Per-IP for webhook endpoints (generous — lenders batch) */
export const WEBHOOK_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 100,
  windowMs: 60 * 1000, // 100 per minute per IP
}
