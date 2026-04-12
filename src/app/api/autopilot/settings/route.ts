import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/autopilot/settings — Get autopilot configuration for the user's org
 * PATCH /api/autopilot/settings — Update autopilot settings
 */

export async function GET() {
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: org } = await supabase
    .from('organizations')
    .select(`
      autopilot_enabled,
      autopilot_paused,
      autopilot_confidence_threshold,
      autopilot_mode,
      autopilot_response_delay_min,
      autopilot_response_delay_max,
      autopilot_max_messages_per_hour,
      autopilot_active_hours_start,
      autopilot_active_hours_end,
      autopilot_stop_words,
      autopilot_speed_to_lead
    `)
    .eq('id', profile.organization_id)
    .single()

  if (!org) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
  }

  return NextResponse.json({ settings: org })
}

export async function PATCH(request: NextRequest) {
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Only admins can modify autopilot settings
  if (profile.role !== 'admin') {
    return NextResponse.json({ error: 'Only admins can modify autopilot settings' }, { status: 403 })
  }

  const body = await request.json()

  // Allowlist of updatable fields (prevent arbitrary column writes)
  const ALLOWED_FIELDS = new Set([
    'autopilot_enabled',
    'autopilot_paused',
    'autopilot_confidence_threshold',
    'autopilot_mode',
    'autopilot_response_delay_min',
    'autopilot_response_delay_max',
    'autopilot_max_messages_per_hour',
    'autopilot_active_hours_start',
    'autopilot_active_hours_end',
    'autopilot_stop_words',
    'autopilot_speed_to_lead',
  ])

  const updates: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (ALLOWED_FIELDS.has(key)) {
      updates[key] = value
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  const { error } = await supabase
    .from('organizations')
    .update(updates)
    .eq('id', profile.organization_id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, updated: Object.keys(updates) })
}
