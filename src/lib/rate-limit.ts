/**
 * In-memory sliding window rate limiter.
 * Works per serverless instance — provides burst protection, not global rate limiting.
 * For global rate limiting, use Upstash Redis (@upstash/ratelimit).
 */

type RateLimitEntry = {
  timestamps: number[]
}

const store = new Map<string, RateLimitEntry>()

// Periodically clean up old entries to prevent memory leaks
const CLEANUP_INTERVAL = 60_000 // 1 minute
let lastCleanup = Date.now()

function cleanup(windowMs: number) {
  const now = Date.now()
  if (now - lastCleanup < CLEANUP_INTERVAL) return
  lastCleanup = now

  const cutoff = now - windowMs
  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff)
    if (entry.timestamps.length === 0) {
      store.delete(key)
    }
  }
}

export type RateLimitConfig = {
  /** Maximum requests allowed in the time window */
  maxRequests: number
  /** Time window in milliseconds */
  windowMs: number
}

export type RateLimitResult = {
  allowed: boolean
  remaining: number
  resetAt: number
}

/**
 * Check if a request is within rate limits.
 * @param key - Unique identifier (e.g., IP address, org ID)
 * @param config - Rate limit configuration
 */
export function checkRateLimit(key: string, config: RateLimitConfig): RateLimitResult {
  const now = Date.now()
  const cutoff = now - config.windowMs

  cleanup(config.windowMs)

  let entry = store.get(key)
  if (!entry) {
    entry = { timestamps: [] }
    store.set(key, entry)
  }

  // Remove timestamps outside the window
  entry.timestamps = entry.timestamps.filter((t) => t > cutoff)

  if (entry.timestamps.length >= config.maxRequests) {
    const oldestInWindow = entry.timestamps[0]
    return {
      allowed: false,
      remaining: 0,
      resetAt: oldestInWindow + config.windowMs,
    }
  }

  entry.timestamps.push(now)
  return {
    allowed: true,
    remaining: config.maxRequests - entry.timestamps.length,
    resetAt: now + config.windowMs,
  }
}

// Preset configurations for different endpoint types
export const RATE_LIMITS = {
  /** Webhook endpoints: 60 requests per minute per IP */
  webhook: { maxRequests: 60, windowMs: 60_000 },
  /** Public form endpoints: 10 requests per minute per IP */
  publicForm: { maxRequests: 10, windowMs: 60_000 },
  /** AI endpoints: 20 requests per minute per user */
  ai: { maxRequests: 20, windowMs: 60_000 },
  /** API endpoints: 100 requests per minute per user */
  api: { maxRequests: 100, windowMs: 60_000 },
} as const
