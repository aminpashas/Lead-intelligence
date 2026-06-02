/**
 * POST /api/agency/practices
 *
 * Onboards a new client practice (organization). Agency-admin only. The
 * organizations RLS already grants agency admins INSERT (migration 018), and
 * an AFTER INSERT trigger seeds default pipeline stages, so the new practice is
 * immediately usable once entered.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .single()

  if (!profile || profile.role !== 'agency_admin') {
    return NextResponse.json({ error: 'Forbidden — agency access required' }, { status: 403 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    name?: string
    email?: string
    phone?: string
  }

  const name = body.name?.trim()
  if (!name) {
    return NextResponse.json({ error: 'Practice name is required' }, { status: 400 })
  }

  // Mirror the signup slug convention: slugified name + a short unique suffix.
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const slug = `${base || 'practice'}-${Date.now().toString(36)}`

  const { data: org, error } = await supabase
    .from('organizations')
    .insert({
      name,
      slug,
      ...(body.email?.trim() ? { email: body.email.trim() } : {}),
      ...(body.phone?.trim() ? { phone: body.phone.trim() } : {}),
    })
    .select('id, name, slug')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ practice: org })
}
