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
import { getOwnProfile } from '@/lib/auth/active-org'

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await getOwnProfile(supabase, 'role')

  if (!profile || profile.role !== 'agency_admin') {
    return NextResponse.json({ error: 'Forbidden — agency access required' }, { status: 403 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    name?: string
    email?: string
    phone?: string
    // A location may be onboarded under an enterprise (DSO) umbrella. Optional —
    // omit for a standalone single-location practice.
    enterprise_account_id?: string
    // Optional per-location pricing at onboarding. Each location bills
    // independently, so these seed THIS org's subscription + re-bill config.
    subscription_tier?: 'trial' | 'starter' | 'professional' | 'enterprise'
    markups?: Record<string, number>
    platform_fee_cents?: number
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
      ...(body.enterprise_account_id ? { enterprise_account_id: body.enterprise_account_id } : {}),
      ...(body.subscription_tier ? { subscription_tier: body.subscription_tier } : {}),
    })
    .select('id, name, slug')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Seed per-location re-bill config when provided, so pricing is explicit rather
  // than falling back to platform defaults (src/lib/billing/markup.ts). Empty
  // markups + a 0 fee are meaningful (= platform defaults / no fee), so only seed
  // when at least one pricing field was actually supplied.
  const hasPricing =
    body.markups !== undefined || body.platform_fee_cents !== undefined
  if (hasPricing) {
    const { error: bsError } = await supabase.from('billing_settings').upsert(
      {
        organization_id: org.id,
        ...(body.markups !== undefined ? { markups: body.markups } : {}),
        ...(body.platform_fee_cents !== undefined
          ? { platform_fee_cents: body.platform_fee_cents }
          : {}),
      },
      { onConflict: 'organization_id' },
    )
    // Pricing is a nice-to-have at creation time; a failure here shouldn't undo a
    // successfully created practice. Surface it without failing the request.
    if (bsError) {
      return NextResponse.json({ practice: org, warning: `pricing not saved: ${bsError.message}` })
    }
  }

  return NextResponse.json({ practice: org })
}
