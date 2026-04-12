import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'

/**
 * POST /api/autopilot/kill-switch — Instantly pause all AI auto-sends
 * This is the emergency stop button.
 */

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (profile.role !== 'admin') {
    return NextResponse.json({ error: 'Only admins can activate the kill switch' }, { status: 403 })
  }

  await supabase
    .from('organizations')
    .update({ autopilot_paused: true })
    .eq('id', profile.organization_id)

  return NextResponse.json({
    ok: true,
    message: 'Autopilot PAUSED. No AI messages will be sent until you re-enable it.',
  })
}
