import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { isAdminRole } from '@/lib/auth/permissions'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { z } from 'zod'

const PROTOCOL_COLUMNS =
  'require_call_before_booking, no_show_fee_enabled, no_show_fee_cents, card_on_file_required, youtube_testimonial_url, consult_price_range_text, discovery_script'

// GET /api/settings/booking-protocol — read the phone-first protocol config
export async function GET(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()
  const { orgId, role } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data } = await supabase
    .from('booking_settings')
    .select(PROTOCOL_COLUMNS)
    .eq('organization_id', orgId)
    .maybeSingle()

  // Sensible defaults when the org has no booking_settings row yet.
  return NextResponse.json({
    // Whether the caller (Super-Admin / agency_admin) may flip the mandatory
    // card-on-file switch. Practice admins see it read-only.
    can_edit_card_required: role === 'agency_admin',
    settings: data ?? {
      require_call_before_booking: false,
      no_show_fee_enabled: false,
      no_show_fee_cents: 5000,
      card_on_file_required: false,
      youtube_testimonial_url: null,
      consult_price_range_text: null,
      discovery_script: null,
    },
  })
}

const patchSchema = z.object({
  require_call_before_booking: z.boolean().optional(),
  no_show_fee_enabled: z.boolean().optional(),
  no_show_fee_cents: z.number().int().min(0).max(100000).optional(),
  card_on_file_required: z.boolean().optional(),
  youtube_testimonial_url: z.string().url().max(500).nullish().or(z.literal('')),
  consult_price_range_text: z.string().max(200).nullish(),
  discovery_script: z.string().max(10000).nullish(),
})

// PATCH /api/settings/booking-protocol — admin-only update (upsert)
export async function PATCH(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single()
  if (!profile || !isAdminRole(profile.role)) {
    return NextResponse.json({ error: 'Only admins can modify booking settings' }, { status: 403 })
  }

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }

  // Normalise empty strings to null so we don't store blanks.
  const update: Record<string, unknown> = { ...parsed.data }
  if (update.youtube_testimonial_url === '') update.youtube_testimonial_url = null
  if (update.consult_price_range_text === '') update.consult_price_range_text = null
  if (update.discovery_script === '') update.discovery_script = null

  // The mandatory card-on-file switch is Super-Admin (agency_admin) only. A
  // practice admin's save simply leaves it untouched rather than failing.
  if ('card_on_file_required' in update && profile.role !== 'agency_admin') {
    delete update.card_on_file_required
  }

  const { data, error } = await supabase
    .from('booking_settings')
    .upsert({ organization_id: orgId, ...update }, { onConflict: 'organization_id' })
    .select(PROTOCOL_COLUMNS)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ settings: data })
}
