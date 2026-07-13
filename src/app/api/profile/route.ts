import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { getOwnProfile } from '@/lib/auth/active-org'

/**
 * Self-serve profile fields the signed-in user may edit about themselves.
 *
 * Today that's just their mobile number, which powers "Call my phone" (the
 * ring-my-phone bridge dial in /api/voice/bridge). Previously the only place to
 * set an agent's phone was Team settings — an admin-only surface — so an agent
 * couldn't enable forwarding for themselves. This closes that gap.
 *
 * GET   → { phone: string | null }
 * PATCH → { phone } accepts a number or '' (to clear); returns the stored value.
 *
 * Validation MUST match the bridge gate's check
 * (src/app/api/voice/bridge/route.ts) so any number saved here is guaranteed to
 * pass it: strip spaces/dashes/parens, then require /^\+?1?\d{10,15}$/.
 *
 * RLS: user_profiles has a self-update policy (id = auth.uid()) and the
 * privilege-guard trigger only blocks role/org changes, so writing one's own
 * phone is permitted with the caller's client. See notification-prefs/route.ts.
 */

// Same normalization + shape the bridge route enforces before it dials.
function normalizePhone(raw: string): string {
  return raw.replace(/[\s\-()]/g, '')
}
const PHONE_RE = /^\+?1?\d{10,15}$/

export async function GET(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()
  const { data: profile } = await getOwnProfile(supabase, 'id, phone')
  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.json({ phone: (profile.phone as string | null) ?? null })
}

export async function PATCH(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()
  const { data: profile } = await getOwnProfile(supabase, 'id')
  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!('phone' in body) || typeof body.phone !== 'string') {
    return NextResponse.json({ error: 'phone must be a string' }, { status: 400 })
  }

  // Empty string clears the number; anything else must pass the bridge check.
  const trimmed = body.phone.trim()
  let stored: string | null = null
  if (trimmed !== '') {
    const normalized = normalizePhone(trimmed)
    if (!PHONE_RE.test(normalized)) {
      return NextResponse.json(
        { error: 'Enter a valid phone number, e.g. +14155551234' },
        { status: 400 }
      )
    }
    stored = normalized
  }

  const { error } = await supabase
    .from('user_profiles')
    .update({ phone: stored })
    .eq('id', profile.id as string)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ phone: stored })
}
