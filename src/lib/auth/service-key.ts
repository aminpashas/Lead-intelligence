/**
 * Service-key auth for inbound calls from sibling Vercel projects.
 *
 * Used by routes that don't have an interactive user session — most
 * importantly /api/v1/* which is consumed by dion-growth-studio. Each
 * caller has its own env-stored key so we can revoke one without
 * affecting the others.
 *
 * Env vars (Vercel only, never committed):
 *   GROWTH_STUDIO_SERVICE_KEY        — dion-growth-studio bridge key
 *   GROWTH_STUDIO_ALLOWED_ORG_IDS    — comma-separated org (customer) UUIDs this
 *                                      caller may read/write. Unset or '*' means
 *                                      unrestricted (single-tenant compat) and
 *                                      logs a one-time warning. SET THIS in prod.
 *
 * Usage:
 *   const auth = verifyServiceKey(request);
 *   if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
 *   // auth.caller is e.g. "growth-studio"; auth.allowedOrgIds bounds the org scope.
 */
import { timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { logger } from '@/lib/logger'

const SERVICE_KEYS: Record<string, string | undefined> = {
  'growth-studio': process.env.GROWTH_STUDIO_SERVICE_KEY,
}

// Per-caller env var holding the comma-separated org-id allowlist.
const ALLOWLIST_ENV: Record<string, string> = {
  'growth-studio': 'GROWTH_STUDIO_ALLOWED_ORG_IDS',
}

export type ServiceAuth = {
  caller: string
  /** Org UUIDs this caller may touch, or '*' for unrestricted. */
  allowedOrgIds: string[] | '*'
}

const unrestrictedWarned = new Set<string>()

function resolveAllowedOrgIds(caller: string): string[] | '*' {
  const envName = ALLOWLIST_ENV[caller]
  const raw = envName ? process.env[envName] : undefined
  const trimmed = (raw ?? '').trim()
  if (!trimmed || trimmed === '*') {
    if (!unrestrictedWarned.has(caller)) {
      unrestrictedWarned.add(caller)
      logger.warn(
        `Service bridge "${caller}" is UNRESTRICTED — set ${envName ?? '<allowlist env>'} to a comma-separated org-id list to lock it down.`,
      )
    }
    return '*'
  }
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Verify the Authorization: Bearer <key> header against the configured
 * service keys. Returns the caller's logical name + org allowlist on success,
 * null otherwise.
 */
export function verifyServiceKey(request: NextRequest): ServiceAuth | null {
  const header = request.headers.get('authorization') ?? ''
  if (!header.toLowerCase().startsWith('bearer ')) return null
  const presented = header.slice(7).trim()
  if (!presented) return null

  for (const [caller, expected] of Object.entries(SERVICE_KEYS)) {
    if (!expected) continue
    if (constantTimeEqual(presented, expected)) {
      return { caller, allowedOrgIds: resolveAllowedOrgIds(caller) }
    }
  }
  return null
}

/**
 * True if the verified caller is allowed to act on the given org/customer id.
 * '*' allowlist permits any org (single-tenant / unrestricted mode).
 */
export function isOrgAllowed(auth: ServiceAuth, orgId: string): boolean {
  if (auth.allowedOrgIds === '*') return true
  return auth.allowedOrgIds.includes(orgId)
}
