import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { getOwnProfile } from '@/lib/auth/active-org'

/**
 * Per-user notification channel preferences (Workstream D5).
 *
 * Stored in user_profiles.notification_prefs (jsonb). Empty object = all
 * channels ON (default-on posture); an explicit `false` opts a channel off.
 * Consumed by src/lib/notifications/staff-notify.ts and
 * src/lib/autopilot/escalation.ts.
 *
 * GET   → { prefs: { slack?, sms?, email?, push? } }
 * PATCH → merge the provided subset of channel booleans into the stored
 *         object and return the merged result.
 *
 * RLS: user_profiles has a self-update policy (id = auth.uid()) and the
 * privilege-guard trigger only blocks role/org changes, so writing one's own
 * notification_prefs is permitted with the caller's client.
 */

const CHANNELS = ['slack', 'sms', 'email', 'push'] as const
type Channel = (typeof CHANNELS)[number]
type Prefs = Partial<Record<Channel, boolean>>

export async function GET(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()
  const { data: profile } = await getOwnProfile(supabase, 'id, notification_prefs')
  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.json({ prefs: (profile.notification_prefs as Prefs) ?? {} })
}

export async function PATCH(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()
  const { data: profile } = await getOwnProfile(supabase, 'id, notification_prefs')
  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const patch: Prefs = {}
  for (const channel of CHANNELS) {
    if (channel in body) {
      if (typeof body[channel] !== 'boolean') {
        return NextResponse.json(
          { error: `${channel} must be a boolean` },
          { status: 400 }
        )
      }
      patch[channel] = body[channel] as boolean
    }
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: `Provide at least one of: ${CHANNELS.join(', ')}` },
      { status: 400 }
    )
  }

  const merged: Prefs = { ...((profile.notification_prefs as Prefs) ?? {}), ...patch }

  const { error } = await supabase
    .from('user_profiles')
    .update({ notification_prefs: merged })
    .eq('id', profile.id as string)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ prefs: merged })
}
