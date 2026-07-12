import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { requirePermission } from '@/lib/auth/active-org'

/**
 * /api/automation/policies — CRUD for automation_policies (ownership matrix).
 *
 * GET    — list every policy row for the org (enabled + disabled) so the
 *          Command Center matrix can render configured vs effective state.
 *          Gate: ai_control:read (same as viewing /settings/ai).
 * POST   — upsert ONE policy by (scope, target). The table enforces one row
 *          per target via partial unique indexes; we select-then-write so the
 *          editor is idempotent. Gate: ai_control:write (agency-side, same
 *          line as autopilot settings — retuning automation stays with the
 *          company).
 * DELETE — ?id=<uuid>: remove a policy → that target falls back to the next
 *          scope in precedence / the AI default. Gate: ai_control:write.
 *
 * Voice campaigns are read-only v1: their allocation lives in voice_campaigns
 * columns (agent_type / live_transfer_enabled), so this route deliberately
 * does not accept voice_campaign_id.
 */

const dayScheduleSchema = z
  .object({
    enabled: z.boolean(),
    start: z.number().int().min(0).max(23),
    end: z.number().int().min(1).max(24),
  })
  .refine((d) => d.start < d.end, { message: 'start must be before end' })

const weekScheduleSchema = z.object({
  sunday: dayScheduleSchema,
  monday: dayScheduleSchema,
  tuesday: dayScheduleSchema,
  wednesday: dayScheduleSchema,
  thursday: dayScheduleSchema,
  friday: dayScheduleSchema,
  saturday: dayScheduleSchema,
})

const KIND_VALUES = [
  'inbound_reply',
  'speed_to_lead',
  'nurture_step',
  'stage_automation',
  'recommendation',
] as const

const upsertSchema = z
  .object({
    scope: z.enum(['org_default', 'campaign', 'stage', 'segment']),
    campaign_id: z.string().uuid().nullish(),
    stage_id: z.string().uuid().nullish(),
    smart_list_id: z.string().uuid().nullish(),
    owner: z.enum(['ai', 'human', 'hybrid']),
    ai_role: z.enum(['setter', 'closer']).nullish(),
    human_schedule: weekScheduleSchema.nullish(),
    human_first: z.boolean().optional(),
    human_response_sla_seconds: z.number().int().min(30).max(3600).optional(),
    kinds: z.array(z.enum(KIND_VALUES)).max(KIND_VALUES.length).optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (d) => {
      // Mirror the table's scope_target CHECK so bad input 400s here instead
      // of surfacing as an opaque constraint violation.
      switch (d.scope) {
        case 'org_default':
          return !d.campaign_id && !d.stage_id && !d.smart_list_id
        case 'campaign':
          return !!d.campaign_id && !d.stage_id && !d.smart_list_id
        case 'stage':
          return !!d.stage_id && !d.campaign_id && !d.smart_list_id
        case 'segment':
          return !!d.smart_list_id && !d.campaign_id && !d.stage_id
      }
    },
    { message: 'scope and target id do not match' }
  )

export async function GET(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()
  const guard = await requirePermission(supabase, 'ai_control:read')
  if ('error' in guard) return guard.error

  const { data, error } = await supabase
    .from('automation_policies')
    .select('*')
    .eq('organization_id', guard.orgId)
    .order('created_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ policies: data ?? [] })
}

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()
  const guard = await requirePermission(supabase, 'ai_control:write')
  if ('error' in guard) return guard.error

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = upsertSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid policy', details: parsed.error.flatten() },
      { status: 400 }
    )
  }
  const input = parsed.data

  // Target ownership check: the campaign/stage/segment being governed must
  // belong to the active org (RLS would also block the write via FK rows, but
  // an explicit check gives a clean 404 instead of a constraint error).
  const targetTable =
    input.scope === 'campaign'
      ? ('campaigns' as const)
      : input.scope === 'stage'
        ? ('pipeline_stages' as const)
        : input.scope === 'segment'
          ? ('smart_lists' as const)
          : null
  const targetId = input.campaign_id ?? input.stage_id ?? input.smart_list_id ?? null
  if (targetTable && targetId) {
    const { data: target } = await supabase
      .from(targetTable)
      .select('id')
      .eq('id', targetId)
      .eq('organization_id', guard.orgId)
      .maybeSingle()
    if (!target) {
      return NextResponse.json({ error: 'Target not found in your organization' }, { status: 404 })
    }
  }

  const values = {
    organization_id: guard.orgId,
    scope: input.scope,
    campaign_id: input.campaign_id ?? null,
    voice_campaign_id: null,
    stage_id: input.stage_id ?? null,
    smart_list_id: input.smart_list_id ?? null,
    owner: input.owner,
    ai_role: input.ai_role ?? null,
    human_schedule: input.human_schedule ?? null,
    human_first: input.human_first ?? false,
    human_response_sla_seconds: input.human_response_sla_seconds ?? 180,
    kinds: input.kinds ?? [],
    enabled: input.enabled ?? true,
  }

  // Upsert by (scope, target): one row per target is enforced by partial
  // unique indexes, so find the existing row and update it in place.
  let existingQuery = supabase
    .from('automation_policies')
    .select('id')
    .eq('organization_id', guard.orgId)
    .eq('scope', input.scope)
  if (input.scope === 'campaign') existingQuery = existingQuery.eq('campaign_id', targetId!)
  if (input.scope === 'stage') existingQuery = existingQuery.eq('stage_id', targetId!)
  if (input.scope === 'segment') existingQuery = existingQuery.eq('smart_list_id', targetId!)

  const { data: existing } = await existingQuery.maybeSingle()

  if (existing?.id) {
    const { data, error } = await supabase
      .from('automation_policies')
      .update(values)
      .eq('id', existing.id)
      .eq('organization_id', guard.orgId)
      .select('*')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ policy: data, created: false })
  }

  const { data, error } = await supabase
    .from('automation_policies')
    .insert(values)
    .select('*')
    .single()
  if (error) {
    // Unique-index race (two editors saving the same target): surface as a
    // conflict the client can resolve by refetching.
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Policy already exists — reload and retry' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ policy: data, created: true })
}

export async function DELETE(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()
  const guard = await requirePermission(supabase, 'ai_control:write')
  if ('error' in guard) return guard.error

  const id = request.nextUrl.searchParams.get('id')
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: 'Invalid policy id' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('automation_policies')
    .delete()
    .eq('id', id)
    .eq('organization_id', guard.orgId)
    .select('id')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, deleted: (data?.length ?? 0) > 0 })
}
