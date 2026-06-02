import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'crypto'

// Mock external dependencies
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => {
  const actual = {
    RATE_LIMITS: {
      webhook: { maxRequests: 60, windowMs: 60_000 },
      publicForm: { maxRequests: 10, windowMs: 60_000 },
    },
  }
  return {
    ...actual,
    checkRateLimit: vi.fn().mockReturnValue({ allowed: true, remaining: 59, resetAt: Date.now() + 60_000 }),
  }
})

import {
  verifyWebhookSignature,
  validateOrgId,
  getRawBodyAndParsed,
  validateCustomFields,
  applyRateLimit,
} from '@/lib/webhooks/verify'
import { createServiceClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rate-limit'

const TEST_SECRET = 'test-webhook-secret-123'

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════
// verifyWebhookSignature
// ═══════════════════════════════════════════════════════════════

describe('verifyWebhookSignature', () => {
  it('returns null (valid) for correct HMAC signature', () => {
    process.env.WEBHOOK_SECRET = TEST_SECRET
    const body = '{"event":"lead.created"}'
    const signature = crypto.createHmac('sha256', TEST_SECRET).update(body).digest('hex')

    const result = verifyWebhookSignature(body, signature)

    expect(result).toBeNull()
  })

  it('returns null with prefix when prefix option is used', () => {
    process.env.WEBHOOK_SECRET = TEST_SECRET
    const body = '{"event":"test"}'
    const prefix = 'sha256='
    const hash = crypto.createHmac('sha256', TEST_SECRET).update(body).digest('hex')
    const signature = prefix + hash

    const result = verifyWebhookSignature(body, signature, { prefix })

    expect(result).toBeNull()
  })

  it('rejects when WEBHOOK_SECRET is not configured (fail-closed)', () => {
    delete process.env.WEBHOOK_SECRET
    const body = '{"test": true}'

    const result = verifyWebhookSignature(body, 'some-sig')

    expect(result).not.toBeNull()
    const json = result!.json as any
    // result is a NextResponse — check status
    expect(result!.status).toBe(500)
  })

  it('rejects when signature header is null', () => {
    process.env.WEBHOOK_SECRET = TEST_SECRET
    const body = '{"test": true}'

    const result = verifyWebhookSignature(body, null)

    expect(result).not.toBeNull()
    expect(result!.status).toBe(401)
  })

  it('rejects when signature is incorrect', () => {
    process.env.WEBHOOK_SECRET = TEST_SECRET
    const body = '{"test": true}'
    // Wrong signature (same length to pass length check)
    const wrongSig = crypto.createHmac('sha256', 'wrong-secret').update(body).digest('hex')

    const result = verifyWebhookSignature(body, wrongSig)

    expect(result).not.toBeNull()
    expect(result!.status).toBe(401)
  })

  it('rejects when signature length does not match expected', () => {
    process.env.WEBHOOK_SECRET = TEST_SECRET
    const body = '{"test": true}'

    const result = verifyWebhookSignature(body, 'short')

    expect(result).not.toBeNull()
    expect(result!.status).toBe(401)
  })

  afterEach(() => {
    delete process.env.WEBHOOK_SECRET
  })
})

// ═══════════════════════════════════════════════════════════════
// validateOrgId
// ═══════════════════════════════════════════════════════════════

describe('validateOrgId', () => {
  it('returns orgId for valid UUID', async () => {
    const validUUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { id: validUUID } }),
      }),
    }
    vi.mocked(createServiceClient).mockReturnValue(mockSupabase as any)

    const result = await validateOrgId(validUUID)

    expect(result).toEqual({ orgId: validUUID })
  })

  it('rejects null orgId', async () => {
    const result = await validateOrgId(null)

    expect(result).toHaveProperty('status', 400)
  })

  it('rejects invalid UUID format', async () => {
    const result = await validateOrgId('not-a-uuid')

    expect(result).toHaveProperty('status', 400)
  })

  it('rejects SQL injection attempt', async () => {
    const result = await validateOrgId("'; DROP TABLE organizations; --")

    expect(result).toHaveProperty('status', 400)
  })

  it('returns 404 when org is not found', async () => {
    const validUUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null }),
      }),
    }
    vi.mocked(createServiceClient).mockReturnValue(mockSupabase as any)

    const result = await validateOrgId(validUUID)

    expect(result).toHaveProperty('status', 404)
  })
})

// ═══════════════════════════════════════════════════════════════
// getRawBodyAndParsed
// ═══════════════════════════════════════════════════════════════

describe('getRawBodyAndParsed', () => {
  it('extracts raw body and parses JSON', async () => {
    const body = '{"name":"John","age":30}'
    const request = {
      text: vi.fn().mockResolvedValue(body),
    } as any

    const result = await getRawBodyAndParsed(request)

    expect(result.rawBody).toBe(body)
    expect(result.parsed).toEqual({ name: 'John', age: 30 })
  })

  it('throws on invalid JSON', async () => {
    const request = {
      text: vi.fn().mockResolvedValue('not json'),
    } as any

    await expect(getRawBodyAndParsed(request)).rejects.toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════
// validateCustomFields
// ═══════════════════════════════════════════════════════════════

describe('validateCustomFields', () => {
  it('returns null for valid custom fields', () => {
    const result = validateCustomFields({ foo: 'bar', count: 5 })
    expect(result).toBeNull()
  })

  it('returns null for undefined custom fields', () => {
    const result = validateCustomFields(undefined)
    expect(result).toBeNull()
  })

  it('rejects when more than 50 keys', () => {
    const fields: Record<string, unknown> = {}
    for (let i = 0; i < 51; i++) {
      fields[`key_${i}`] = 'value'
    }

    const result = validateCustomFields(fields)

    expect(result).not.toBeNull()
    expect(result!.status).toBe(400)
  })

  it('rejects when total size exceeds 50KB', () => {
    const fields = {
      big_value: 'x'.repeat(51 * 1024), // > 50KB
    }

    const result = validateCustomFields(fields)

    expect(result).not.toBeNull()
    expect(result!.status).toBe(400)
  })

  it('allows exactly 50 keys', () => {
    const fields: Record<string, unknown> = {}
    for (let i = 0; i < 50; i++) {
      fields[`key_${i}`] = 'v'
    }

    const result = validateCustomFields(fields)
    expect(result).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════
// applyRateLimit
// ═══════════════════════════════════════════════════════════════

describe('applyRateLimit', () => {
  it('returns null when rate limit is not exceeded', () => {
    vi.mocked(checkRateLimit).mockReturnValue({
      allowed: true,
      remaining: 58,
      resetAt: Date.now() + 60_000,
    })

    const request = {
      headers: {
        get: vi.fn((name: string) => {
          if (name === 'x-forwarded-for') return '192.168.1.1'
          return null
        }),
      },
    } as any

    const result = applyRateLimit(request)
    expect(result).toBeNull()
  })

  it('returns 429 when rate limit is exceeded', () => {
    vi.mocked(checkRateLimit).mockReturnValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 30_000,
    })

    const request = {
      headers: {
        get: vi.fn((name: string) => {
          if (name === 'x-forwarded-for') return '192.168.1.1'
          return null
        }),
      },
    } as any

    const result = applyRateLimit(request)

    expect(result).not.toBeNull()
    expect(result!.status).toBe(429)
  })

  it('uses x-real-ip as fallback for IP extraction', () => {
    vi.mocked(checkRateLimit).mockReturnValue({
      allowed: true,
      remaining: 59,
      resetAt: Date.now() + 60_000,
    })

    const request = {
      headers: {
        get: vi.fn((name: string) => {
          if (name === 'x-real-ip') return '10.0.0.1'
          return null
        }),
      },
    } as any

    applyRateLimit(request)

    expect(checkRateLimit).toHaveBeenCalledWith('10.0.0.1', expect.any(Object))
  })

  it('uses "unknown" when no IP headers present', () => {
    vi.mocked(checkRateLimit).mockReturnValue({
      allowed: true,
      remaining: 59,
      resetAt: Date.now() + 60_000,
    })

    const request = {
      headers: {
        get: vi.fn().mockReturnValue(null),
      },
    } as any

    applyRateLimit(request)

    expect(checkRateLimit).toHaveBeenCalledWith('unknown', expect.any(Object))
  })

  it('includes Retry-After header in 429 response', () => {
    const resetAt = Date.now() + 45_000
    vi.mocked(checkRateLimit).mockReturnValue({
      allowed: false,
      remaining: 0,
      resetAt,
    })

    const request = {
      headers: {
        get: vi.fn().mockReturnValue(null),
      },
    } as any

    const result = applyRateLimit(request)

    expect(result!.headers.get('Retry-After')).toBeTruthy()
    expect(result!.headers.get('X-RateLimit-Remaining')).toBe('0')
  })
})
