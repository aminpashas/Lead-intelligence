import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'

/**
 * GET /api/notifications/badges — outstanding-work counts for the left-nav
 * notification badges (iPhone/macOS-style unread counts).
 *
 * Returns a map keyed by nav href so the sidebar can look each one up directly:
 *   { "/tasks", "/conversations", "/call-center", "/leads", "/appointments" }
 *
 * All counting lives in the `nav_badge_counts` RPC (one round-trip, RLS-scoped
 * to the caller's org, definitions shared with the pages the badges point at).
 * This is a courtesy surface: any failure degrades to all-zero badges rather
 * than surfacing an error — the nav must never break because a count didn't load.
 */
export async function GET(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const empty = {
    '/tasks': 0,
    '/conversations': 0,
    '/call-center': 0,
    '/leads': 0,
    '/appointments': 0,
  }

  const supabase = await createClient()

  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')
  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabase.rpc('nav_badge_counts', { p_org: orgId })
  if (error) {
    // Never break the nav over a badge — log and hand back zeros.
    console.error('[nav-badges] count failed:', error.message)
    return NextResponse.json(empty)
  }

  // The RPC returns a single row; PostgREST hands set-returning functions back
  // as an array.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { tasks?: number; conversations?: number; call_center?: number; leads?: number; appointments?: number }
    | null
    | undefined

  return NextResponse.json({
    '/tasks': row?.tasks ?? 0,
    '/conversations': row?.conversations ?? 0,
    '/call-center': row?.call_center ?? 0,
    '/leads': row?.leads ?? 0,
    '/appointments': row?.appointments ?? 0,
  })
}
