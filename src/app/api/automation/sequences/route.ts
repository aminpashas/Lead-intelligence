import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { hasPermission } from '@/lib/auth/permissions'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { loadAllSequences } from '@/lib/automation/sequences'

/**
 * GET  /api/automation/sequences — all outreach sequences (with steps) for the
 *      active org, plus the runtime gate flags the Workflows tab surfaces.
 * POST /api/automation/sequences — create a custom sequence.
 */

export async function GET(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()
  const { data: profile } = await getOwnProfile(supabase, 'organization_id')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sequences = await loadAllSequences(supabase, orgId)

  return NextResponse.json({
    sequences,
    gates: {
      followup_cron_enabled: process.env.FOLLOWUP_SEQUENCES_ENABLED === 'true',
      ai_calls_enabled: process.env.SEQUENCE_AI_CALLS_ENABLED === 'true',
      messaging_dry_run: process.env.MESSAGING_DRY_RUN === '1',
    },
  })
}

const createSequenceSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(500).optional(),
  trigger: z.enum(['lead_created', 'appointment']),
  stop_on_reply: z.boolean().optional(),
  stop_on_booking: z.boolean().optional(),
})

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()
  const { data: profile } = await getOwnProfile(supabase, 'organization_id, role')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(profile.role, 'ai_control:write')) {
    return NextResponse.json({ error: 'Workflows are managed by your agency' }, { status: 403 })
  }

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = createSequenceSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid sequence', details: parsed.error.flatten() }, { status: 400 })
  }

  const key = `custom_${parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}_${Date.now().toString(36)}`
  const { data: created, error } = await supabase
    .from('outreach_sequences')
    .insert({
      organization_id: orgId,
      key,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      trigger: parsed.data.trigger,
      anchor: parsed.data.trigger === 'appointment' ? 'appointment_time' : 'enrollment',
      is_system: false,
      enabled: false, // custom sequences start paused
      stop_on_reply: parsed.data.stop_on_reply ?? true,
      stop_on_booking: parsed.data.stop_on_booking ?? true,
    })
    .select('*')
    .single()

  if (error || !created) {
    return NextResponse.json({ error: 'Failed to create sequence', detail: error?.message }, { status: 500 })
  }
  return NextResponse.json({ sequence: { ...created, steps: [] } }, { status: 201 })
}
