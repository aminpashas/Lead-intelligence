import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { hasPermission } from '@/lib/auth/permissions'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'

/**
 * PUT /api/automation/sequences/[id]/steps — bulk replace a sequence's steps.
 *
 * Steps carrying an `id` are UPDATED in place (preserving the id keeps
 * task/reminder dedupe history intact); steps without one are inserted;
 * existing steps missing from the payload are deleted.
 *
 * The 'speed_to_lead' proxy step also mirrors its owner into the org-default
 * automation_policies row (kinds=['speed_to_lead']) so the allocation resolver
 * actually routes the instant first touch to a human when asked.
 */

const stepSchema = z.object({
  id: z.string().uuid().optional(),
  position: z.number().int().min(0).max(200),
  offset_minutes: z.number().int().min(-40320).max(129600), // −28d … +90d
  channel: z.enum(['sms', 'email', 'ai_call', 'human_call', 'human_task']),
  owner: z.enum(['ai', 'human']),
  condition: z.enum(['always', 'unconfirmed', 'confirmed']).default('always'),
  intent: z.string().max(1000).nullable().optional(),
  template_subject: z.string().max(200).nullable().optional(),
  template_body: z.string().max(4000).nullable().optional(),
  enabled: z.boolean().default(true),
})

const putSchema = z.object({
  steps: z.array(stepSchema).max(50),
}).refine(
  (d) => new Set(d.steps.map((s) => s.position)).size === d.steps.length,
  { message: 'positions must be unique' }
)

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const { id: sequenceId } = await params
  const supabase = await createClient()
  const { data: profile } = await getOwnProfile(supabase, 'organization_id, role')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(profile.role, 'ai_control:write')) {
    return NextResponse.json({ error: 'Workflows are managed by your agency' }, { status: 403 })
  }
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: seq } = await supabase
    .from('outreach_sequences')
    .select('id, key, anchor')
    .eq('id', sequenceId)
    .eq('organization_id', orgId)
    .maybeSingle()
  if (!seq) return NextResponse.json({ error: 'Sequence not found' }, { status: 404 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = putSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid steps', details: parsed.error.flatten() }, { status: 400 })
  }

  const { data: existingRows } = await supabase
    .from('outreach_sequence_steps')
    .select('id, kind')
    .eq('sequence_id', sequenceId)
  const existing = existingRows ?? []
  const existingIds = new Set(existing.map((s) => s.id))
  const kindById = new Map(existing.map((s) => [s.id, s.kind]))

  const payloadIds = new Set(parsed.data.steps.map((s) => s.id).filter(Boolean) as string[])
  for (const pid of payloadIds) {
    if (!existingIds.has(pid)) {
      return NextResponse.json({ error: `Unknown step id ${pid}` }, { status: 400 })
    }
  }

  // 1) Delete steps removed from the payload (speed_to_lead proxies persist).
  const toDelete = existing
    .filter((s) => !payloadIds.has(s.id) && s.kind !== 'speed_to_lead')
    .map((s) => s.id)
  if (toDelete.length > 0) {
    await supabase.from('outreach_sequence_steps').delete().in('id', toDelete)
  }

  // 2) Park surviving rows at shifted positions so re-ordering can't trip the
  //    unique(sequence_id, position) constraint mid-update.
  const { data: survivors } = await supabase
    .from('outreach_sequence_steps')
    .select('id, position')
    .eq('sequence_id', sequenceId)
  for (const s of survivors ?? []) {
    await supabase
      .from('outreach_sequence_steps')
      .update({ position: s.position + 1000 })
      .eq('id', s.id)
  }

  // 3) Apply updates / inserts at their final positions.
  const warnings: string[] = []
  for (const step of parsed.data.steps) {
    const base = {
      position: step.position,
      offset_minutes: step.offset_minutes,
      channel: step.channel,
      owner: step.owner,
      condition: step.condition,
      intent: step.intent ?? null,
      template_subject: step.template_subject ?? null,
      template_body: step.template_body ?? null,
      enabled: step.enabled,
    }
    if (step.id) {
      const isSpeedToLead = kindById.get(step.id) === 'speed_to_lead'
      const { error } = await supabase
        .from('outreach_sequence_steps')
        .update(
          // The proxy step keeps its instant timing + sms channel; owner,
          // intent and enabled are the editable bits.
          isSpeedToLead ? { ...base, offset_minutes: 0, channel: 'sms' } : base
        )
        .eq('id', step.id)
        .eq('sequence_id', sequenceId)
      if (error) return NextResponse.json({ error: `Step update failed: ${error.message}` }, { status: 500 })
      if (isSpeedToLead) {
        const warning = await mirrorSpeedToLeadOwner(supabase, orgId, step.owner)
        if (warning) warnings.push(warning)
      }
    } else {
      const { error } = await supabase.from('outreach_sequence_steps').insert({
        ...base,
        organization_id: orgId,
        sequence_id: sequenceId,
        kind: 'step',
      })
      if (error) return NextResponse.json({ error: `Step insert failed: ${error.message}` }, { status: 500 })
    }
  }

  const { data: steps } = await supabase
    .from('outreach_sequence_steps')
    .select('*')
    .eq('sequence_id', sequenceId)
    .order('position', { ascending: true })

  return NextResponse.json({ steps: steps ?? [], warnings: warnings.length ? warnings : undefined })
}

/**
 * Keep the allocation layer in sync with the speed_to_lead proxy step's owner.
 * Only touches an org-default policy this feature owns (kinds exactly
 * ['speed_to_lead']); a broader pre-existing policy wins and yields a warning.
 */
async function mirrorSpeedToLeadOwner(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  owner: 'ai' | 'human'
): Promise<string | null> {
  const { data: policy } = await supabase
    .from('automation_policies')
    .select('id, kinds, owner')
    .eq('organization_id', orgId)
    .eq('scope', 'org_default')
    .maybeSingle()

  if (!policy) {
    if (owner === 'ai') return null // legacy default already routes to AI
    const { error } = await supabase.from('automation_policies').insert({
      organization_id: orgId,
      scope: 'org_default',
      kinds: ['speed_to_lead'],
      owner: 'human',
    })
    return error ? `Could not create speed-to-lead allocation policy: ${error.message}` : null
  }

  const kinds = (policy.kinds as string[]) ?? []
  const ownedByThisFeature = kinds.length === 1 && kinds[0] === 'speed_to_lead'
  if (!ownedByThisFeature) {
    return 'First-touch owner is governed by an existing allocation policy — edit it under automation policies.'
  }
  if (policy.owner === owner) return null
  const { error } = await supabase
    .from('automation_policies')
    .update({ owner })
    .eq('id', policy.id)
  return error ? `Could not update speed-to-lead allocation policy: ${error.message}` : null
}
