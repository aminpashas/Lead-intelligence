import { describe, it, expect } from 'vitest'
import { withRetry } from '../retry'

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const result = await withRetry(() => Promise.resolve('ok'))
    expect(result).toBe('ok')
  })

  it('retries on retryable errors', async () => {
    let attempts = 0
    const result = await withRetry(
      () => {
        attempts++
        if (attempts < 3) throw new Error('fetch failed')
        return Promise.resolve('recovered')
      },
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 }
    )
    expect(result).toBe('recovered')
    expect(attempts).toBe(3)
  })

  it('throws after max attempts', async () => {
    await expect(
      withRetry(
        () => { throw new Error('fetch failed') },
        { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 50 }
      )
    ).rejects.toThrow('fetch failed')
  })

  it('does not retry non-retryable errors', async () => {
    let attempts = 0
    await expect(
      withRetry(
        () => {
          attempts++
          throw new Error('validation error')
        },
        { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 }
      )
    ).rejects.toThrow('validation error')
    expect(attempts).toBe(1) // Should not retry
  })
})
