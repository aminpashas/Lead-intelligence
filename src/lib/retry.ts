/**
 * Retry utility with exponential backoff for external service calls.
 * Use for Twilio, Resend, Anthropic API calls.
 */

export type RetryConfig = {
  /** Maximum number of attempts (including the first) */
  maxAttempts: number
  /** Base delay in ms between retries (doubles each attempt) */
  baseDelayMs: number
  /** Maximum delay cap in ms */
  maxDelayMs: number
  /** Only retry on these error types/status codes */
  retryableErrors?: (error: unknown) => boolean
}

const DEFAULT_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10_000,
}

/**
 * Default check for retryable errors.
 * Retries on network errors, 429 (rate limit), and 5xx server errors.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    // Network errors
    if (msg.includes('fetch failed') || msg.includes('econnrefused') || msg.includes('timeout') || msg.includes('enotfound')) {
      return true
    }
    // Rate limit or server errors from API wrappers
    if (msg.includes('rate limit') || msg.includes('429') || msg.includes('503') || msg.includes('502')) {
      return true
    }
  }

  // Check for status code on error objects
  if (typeof error === 'object' && error !== null) {
    const status = (error as Record<string, unknown>).status || (error as Record<string, unknown>).statusCode
    if (typeof status === 'number') {
      return status === 429 || status >= 500
    }
  }

  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Execute a function with retry logic and exponential backoff.
 *
 * @example
 * const result = await withRetry(() => sendSMS(to, body), { maxAttempts: 3 })
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, retryableErrors } = {
    ...DEFAULT_CONFIG,
    ...config,
  }

  const shouldRetry = retryableErrors || isRetryable
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      if (attempt === maxAttempts || !shouldRetry(error)) {
        throw error
      }

      // Exponential backoff with jitter
      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500,
        maxDelayMs
      )
      await sleep(delay)
    }
  }

  throw lastError
}

// Preset configs for different services
export const RETRY_CONFIGS = {
  /** Twilio SMS: retry 3x, generous backoff */
  twilio: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10_000 },
  /** Resend email: retry 3x */
  resend: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10_000 },
  /** Anthropic AI: retry 2x with longer backoff (expensive calls) */
  anthropic: { maxAttempts: 2, baseDelayMs: 2000, maxDelayMs: 15_000 },
} as const
