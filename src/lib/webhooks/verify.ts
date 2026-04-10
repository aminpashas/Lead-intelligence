import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { checkRateLimit, type RateLimitConfig, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * Verify HMAC-SHA256 webhook signature.
 * Returns null if valid, or a NextResponse error if invalid.
 *
 * MANDATORY: If WEBHOOK_SECRET is configured, ALL requests must have a valid signature.
 * If WEBHOOK_SECRET is NOT configured, rejects all requests (fail-closed).
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  options: { prefix?: string } = {}
): NextResponse | null {
  const secret = process.env.WEBHOOK_SECRET

  // Fail-closed: if no secret is configured, reject
  if (!secret) {
    console.error('WEBHOOK_SECRET is not configured — rejecting webhook request')
    return NextResponse.json(
      { error: 'Webhook verification not configured' },
      { status: 500 }
    )
  }

  // Signature is mandatory
  if (!signatureHeader) {
    return NextResponse.json(
      { error: 'Missing webhook signature' },
      { status: 401 }
    )
  }

  const prefix = options.prefix || ''
  const expected = prefix + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex')

  // Constant-time comparison to prevent timing attacks
  if (signatureHeader.length !== expected.length) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const isValid = crypto.timingSafeEqual(
    Buffer.from(signatureHeader),
    Buffer.from(expected)
  )

  if (!isValid) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  return null // valid
}

/**
 * Validate that an organization ID exists in the database.
 * Returns the org ID if valid, or a NextResponse error.
 */
export async function validateOrgId(
  orgId: string | null
): Promise<{ orgId: string } | NextResponse> {
  if (!orgId) {
    return NextResponse.json({ error: 'Organization ID required' }, { status: 400 })
  }

  // Validate UUID format to prevent injection
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(orgId)) {
    return NextResponse.json({ error: 'Invalid organization ID format' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data: org } = await supabase
    .from('organizations')
    .select('id')
    .eq('id', orgId)
    .single()

  if (!org) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
  }

  return { orgId }
}

/**
 * Extract raw body from request for signature verification.
 * Must be called BEFORE request.json() since the body stream can only be read once.
 */
export async function getRawBodyAndParsed(request: NextRequest): Promise<{ rawBody: string; parsed: unknown }> {
  const rawBody = await request.text()
  const parsed = JSON.parse(rawBody)
  return { rawBody, parsed }
}

/**
 * Validate custom_fields size to prevent oversized payloads.
 * Max 50 keys, max 1KB per value, max 50KB total.
 */
export function validateCustomFields(
  customFields: Record<string, unknown> | undefined
): NextResponse | null {
  if (!customFields) return null

  const keys = Object.keys(customFields)
  if (keys.length > 50) {
    return NextResponse.json(
      { error: 'custom_fields exceeds maximum of 50 keys' },
      { status: 400 }
    )
  }

  const serialized = JSON.stringify(customFields)
  if (serialized.length > 50 * 1024) {
    return NextResponse.json(
      { error: 'custom_fields exceeds maximum size of 50KB' },
      { status: 400 }
    )
  }

  return null
}

/**
 * Apply rate limiting to a request.
 * Returns null if allowed, or a 429 NextResponse if rate limited.
 */
export function applyRateLimit(
  request: NextRequest,
  config: RateLimitConfig = RATE_LIMITS.webhook
): NextResponse | null {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'

  const result = checkRateLimit(ip, config)
  if (!result.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((result.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Remaining': '0',
        },
      }
    )
  }

  return null
}
