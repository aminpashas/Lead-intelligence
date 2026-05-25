/**
 * Service-key auth for inbound calls from sibling Vercel projects.
 *
 * Used by routes that don't have an interactive user session — most
 * importantly /api/v1/* which is consumed by dion-growth-studio. Each
 * caller has its own env-stored key so we can revoke one without
 * affecting the others.
 *
 * Env vars (Vercel only, never committed):
 *   GROWTH_STUDIO_SERVICE_KEY  — dion-growth-studio bridge
 *
 * Usage:
 *   const caller = verifyServiceKey(request);
 *   if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
 *   // caller is e.g. "growth-studio" — use for telemetry / per-caller routing.
 */
import { timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'

const SERVICE_KEYS: Record<string, string | undefined> = {
  'growth-studio': process.env.GROWTH_STUDIO_SERVICE_KEY,
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Verify the Authorization: Bearer <key> header against the configured
 * service keys. Returns the caller's logical name on success, null otherwise.
 */
export function verifyServiceKey(request: NextRequest): string | null {
  const header = request.headers.get('authorization') ?? ''
  if (!header.toLowerCase().startsWith('bearer ')) return null
  const presented = header.slice(7).trim()
  if (!presented) return null

  for (const [caller, expected] of Object.entries(SERVICE_KEYS)) {
    if (!expected) continue
    if (constantTimeEqual(presented, expected)) return caller
  }
  return null
}
