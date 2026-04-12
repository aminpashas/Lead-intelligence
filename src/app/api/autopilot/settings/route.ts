import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'

// Strict schema for autopilot settings — prevents injection of invalid values
const autopilotSettingsSchema = z.object({
  autopilot_enabled: z.boolean().optional(),
  autopilot_paused: z.boolean().optional(),
  autopilot_confidence_threshold: z.number().min(0).max(1).optional(),
  autopilot_mode: z.enum(['full', 'review_first', 'review_closers']).optional(),
  autopilot_response_delay_min: z.number().int().min(5).max(600).optional(),
  autopilot_response_delay_max: z.number().int().min(10).max(1800).optional(),
  autopilot_max_messages_per_hour: z.number().int().min(1).max(30).optional(),
  autopilot_active_hours_start: z.number().int().min(0).max(23).optional(),
  autopilot_active_hours_end: z.number().int().min(1).max(24).optional(),
  autopilot_stop_words: z.array(z.string().min(1).max(50)).max(20).optional(),
  autopilot_speed_to_lead: z.boolean().optional(),
}).refine(
  (data) => {
    // Ensure delay_min <= delay_max when both provided
    if (data.autopilot_response_delay_min !== undefined && data.autopilot_response_delay_max !== undefined) {
      return data.autopilot_response_delay_min <= data.autopilot_response_delay_max
    }
    // Ensure active hours start < end when both provided
    if (data.autopilot_active_hours_start !== undefined && data.autopilot_active_hours_end !== undefined) {
      return data.autopilot_active_hours_start < data.autopilot_active_hours_end
    }
    return true
  },
  { message: 'Invalid range: delay_min must be <= delay_max, and active_hours_start must be < active_hours_end' }
)

/**
 * GET /api/autopilot/settings — Get autopilot configuration for the user's org
 * PATCH /api/autopilot/settings — Update autopilot settings
 */

export async function GET(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

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

  // Only admins can modify autopilot settings
  if (profile.role !== 'admin') {
    return NextResponse.json({ error: 'Only admins can modify autopilot settings' }, { status: 403 })
  }

  // Safe JSON parsing (MED-5 fix)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Zod validation with strict ranges (CRIT-2 fix)
  const parsed = autopilotSettingsSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid settings', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  // Filter to only provided fields
  const updates: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) {
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
