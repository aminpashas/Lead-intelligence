/**
 * /api/agency/enterprises
 *
 * Agency-admin CRUD for enterprise accounts (DSO umbrellas that group N
 * locations). GET lists them (with a member-location count); POST creates one.
 *
 * Enterprises are a Dion-side construct: `enterprise_accounts` RLS grants only
 * agency admins access (migration 20260711220000), and these routes re-check the
 * caller's role for defense in depth — mirroring /api/agency/practices.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { getOwnProfile } from '@/lib/auth/active-org'

async function requireAgencyAdmin(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return { error: rlError }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  const { data: profile } = await getOwnProfile(supabase, 'role')
  if (!profile || profile.role !== 'agency_admin') {
    return { error: NextResponse.json({ error: 'Forbidden — agency access required' }, { status: 403 }) }
  }
  return { supabase }
}

export async function GET(request: NextRequest) {
  const guard = await requireAgencyAdmin(request)
  if ('error' in guard) return guard.error
  const { supabase } = guard

  const { data: enterprises, error } = await supabase
    .from('enterprise_accounts')
    .select('id, name, slug, created_at, updated_at')
    .order('name', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Member-location counts, one grouped read (avoids N+1 across enterprises).
  const { data: orgs } = await supabase
    .from('organizations')
    .select('id, enterprise_account_id')
    .not('enterprise_account_id', 'is', null)

  const countByEnterprise: Record<string, number> = {}
  for (const o of orgs ?? []) {
    const eid = o.enterprise_account_id as string | null
    if (eid) countByEnterprise[eid] = (countByEnterprise[eid] ?? 0) + 1
  }

  return NextResponse.json({
    enterprises: (enterprises ?? []).map((e) => ({
      ...e,
      location_count: countByEnterprise[e.id] ?? 0,
    })),
  })
}

export async function POST(request: NextRequest) {
  const guard = await requireAgencyAdmin(request)
  if ('error' in guard) return guard.error
  const { supabase } = guard

  const body = (await request.json().catch(() => ({}))) as { name?: string }
  const name = body.name?.trim()
  if (!name) {
    return NextResponse.json({ error: 'Enterprise name is required' }, { status: 400 })
  }

  // Same slug convention as the practices route: slugified name + short unique suffix.
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const slug = `${base || 'enterprise'}-${Date.now().toString(36)}`

  const { data: enterprise, error } = await supabase
    .from('enterprise_accounts')
    .insert({ name, slug })
    .select('id, name, slug, created_at, updated_at')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ enterprise })
}
