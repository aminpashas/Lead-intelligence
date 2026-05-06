/**
 * Request body size validation middleware.
 * 
 * Prevents memory exhaustion from oversized payloads on serverless functions.
 * Should be called before request.json() in API route handlers.
 */

import { NextRequest, NextResponse } from 'next/server'

/** Default max body size: 100KB — sufficient for all normal API operations */
const DEFAULT_MAX_BODY_SIZE = 100 * 1024 // 100KB

/** Max body size for webhook endpoints (may include HTML email bodies) */
export const WEBHOOK_MAX_BODY_SIZE = 512 * 1024 // 512KB

/**
 * Max body size for bulk import endpoints. The CSV importer caps at 2,000 rows,
 * which can run several hundred KB after JSON-encoding. 4MB stays under Vercel's
 * 4.5MB serverless body limit.
 */
export const BULK_IMPORT_MAX_BODY_SIZE = 4 * 1024 * 1024 // 4MB

/**
 * Check the Content-Length header against the max allowed size.
 * Returns a 413 response if the body is too large, or null if OK.
 * 
 * Note: Content-Length can be spoofed, but this provides a fast-reject
 * mechanism. The real protection is the JSON parsing limit in the runtime.
 */
export function checkBodySize(
  request: NextRequest,
  maxSize: number = DEFAULT_MAX_BODY_SIZE
): NextResponse | null {
  const contentLength = request.headers.get('content-length')
  if (contentLength && parseInt(contentLength) > maxSize) {
    return NextResponse.json(
      { error: `Request body too large. Maximum size: ${Math.round(maxSize / 1024)}KB` },
      { status: 413 }
    )
  }
  return null
}

/**
 * Safely parse JSON body with size enforcement.
 * Reads the body as text first to check actual size, then parses.
 * Returns { data, error } — error is a NextResponse if body is invalid/too large.
 */
export async function safeParseBody<T = unknown>(
  request: NextRequest,
  maxSize: number = DEFAULT_MAX_BODY_SIZE
): Promise<{ data: T; error: null } | { data: null; error: NextResponse }> {
  // Quick reject via Content-Length header
  const sizeError = checkBodySize(request, maxSize)
  if (sizeError) return { data: null, error: sizeError }

  try {
    const text = await request.text()
    if (text.length > maxSize) {
      return {
        data: null,
        error: NextResponse.json(
          { error: `Request body too large. Maximum size: ${Math.round(maxSize / 1024)}KB` },
          { status: 413 }
        ),
      }
    }
    return { data: JSON.parse(text) as T, error: null }
  } catch {
    return {
      data: null,
      error: NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }),
    }
  }
}
