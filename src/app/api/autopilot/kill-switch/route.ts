import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { isAdminRole } from '@/lib/auth/permissions'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'

/**
 * POST /api/autopilot/kill-switch — Instantly pause all AI auto-sends
 * This is the emergency stop button.
 */

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()

  const { data: profile } = await getOwnProfile(supabase, 'organization_id, role')

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Real practice admins are doctor_admin / office_manager / owner — the old
  // check for a literal 'admin' role matched nobody, making the emergency stop
  // unusable. Use the shared role predicate.
  if (!isAdminRole(profile.role)) {
    return NextResponse.json({ error: 'Only admins can activate the kill switch' }, { status: 403 })
  }

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await supabase
    .from('organizations')
    .update({ autopilot_paused: true })
    .eq('id', orgId)

  return NextResponse.json({
    ok: true,
    message: 'Autopilot PAUSED. No AI messages will be sent until you re-enable it.',
  })
}
