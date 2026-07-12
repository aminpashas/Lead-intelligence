import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { hasPermission } from '@/lib/auth/permissions'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'

// Day schedule schema for per-day-of-week settings
const dayScheduleSchema = z.object({
  enabled: z.boolean(),
  start: z.number().int().min(0).max(23),
  end: z.number().int().min(1).max(24),
  mode: z.enum(['full', 'review_first', 'review_closers']).optional(),
}).refine((d) => d.start < d.end, { message: 'start must be before end' })

const weekScheduleSchema = z.object({
  sunday: dayScheduleSchema,
  monday: dayScheduleSchema,
  tuesday: dayScheduleSchema,
  wednesday: dayScheduleSchema,
  thursday: dayScheduleSchema,
  friday: dayScheduleSchema,
  saturday: dayScheduleSchema,
})

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
  autopilot_schedule: weekScheduleSchema.nullable().optional(),
  // D3: human-first response window — hold inbound replies for a human for
  // this many seconds before the AI takes over (same 30s-1h range as
  // automation_policies.human_response_sla_seconds).
  human_first_sla_enabled: z.boolean().optional(),
  human_first_sla_seconds: z.number().int().min(30).max(3600).optional(),
  // Shadow mode: agents score/draft but never send. Toggled from the
  // Automation Command Center (with an explicit go-live confirm).
  autopilot_outreach_suppressed: z.boolean().optional(),
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

  const { data: profile } = await getOwnProfile(supabase, 'organization_id')

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) {
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
      autopilot_speed_to_lead,
      autopilot_schedule,
      autopilot_outreach_suppressed,
      human_first_sla_enabled,
      human_first_sla_seconds
    `)
    .eq('id', orgId)
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

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Tuning the AI (autopilot config) is agency-side — ai_control:write is held
  // only by agency_admin. Practice admins keep ai_control:read (they can see the
  // settings) and can still hit the kill-switch, but retuning the automation
  // stays with the company. This is the "power stays on the company side" line.
  if (!hasPermission(profile.role, 'ai_control:write')) {
    return NextResponse.json({ error: 'AI settings are managed by your agency' }, { status: 403 })
  }

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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
    .eq('id', orgId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, updated: Object.keys(updates) })
}
