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

/**
 * Distributed rate limit check backed by Upstash Redis (REST API).
 *
 * The in-memory limiter above only protects a single serverless instance — on
 * Vercel each concurrent lambda has its own Map, so the global cap is
 * effectively maxRequests × instanceCount. This uses a shared Redis counter so
 * the cap holds across all instances.
 *
 * Activates only when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set.
 * If unset or Redis errors, returns null so callers fall back to the in-memory
 * limiter (fail-open — never block legitimate traffic on an infra hiccup).
 */
export async function checkRateLimitRedis(
  key: string,
  config: RateLimitConfig,
): Promise<RateLimitResult | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null

  const windowSec = Math.max(1, Math.ceil(config.windowMs / 1000))
  const redisKey = `rl:${key}:${windowSec}:${config.maxRequests}`

  try {
    // Fixed-window counter: INCR then set TTL only on first hit (EXPIRE ... NX).
    const res = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['INCR', redisKey],
        ['EXPIRE', redisKey, String(windowSec), 'NX'],
      ]),
      signal: AbortSignal.timeout(2000),
    })

    if (!res.ok) return null
    const data = (await res.json()) as Array<{ result?: number }>
    const count = data[0]?.result ?? 0
    return {
      allowed: count <= config.maxRequests,
      remaining: Math.max(0, config.maxRequests - count),
      resetAt: Date.now() + config.windowMs,
    }
  } catch {
    return null // network/timeout → fall back to in-memory
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
