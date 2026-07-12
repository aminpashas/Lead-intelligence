import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'

/**
 * POST /api/push/subscribe — store the caller's Web Push subscription (D5).
 *
 * Body: the browser's PushSubscription.toJSON() shape —
 *   { endpoint: string, keys: { p256dh: string, auth: string } }
 *
 * Upserts on `endpoint` (re-subscribing the same browser refreshes the row in
 * place). Rows are user-owned: RLS enforces user_id = auth.uid() and
 * organization_id = get_user_org_id() on insert, mirrored here explicitly.
 */
export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()

  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')
  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { endpoint?: unknown; keys?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : ''
  if (!endpoint || !/^https:\/\//.test(endpoint)) {
    return NextResponse.json(
      { error: 'endpoint must be an https push service URL' },
      { status: 400 }
    )
  }

  const keys = (body.keys ?? {}) as Record<string, unknown>
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : ''
  const auth = typeof keys.auth === 'string' ? keys.auth : ''
  if (!p256dh || !auth) {
    return NextResponse.json(
      { error: 'keys.p256dh and keys.auth are required' },
      { status: 400 }
    )
  }

  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      organization_id: orgId,
      user_id: profile.id as string,
      endpoint,
      keys: { p256dh, auth },
      user_agent: request.headers.get('user-agent')?.slice(0, 500) || null,
    },
    { onConflict: 'endpoint' }
  )

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
