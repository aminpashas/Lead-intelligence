import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, requirePermission } from '@/lib/auth/active-org'
import { resolveSmartListLeads } from '@/lib/campaigns/smart-list-resolver'
import {
  createHumanTask,
  resolveAssignee,
  taskDedupeKeyForListCall,
} from '@/lib/automation/tasks'
import type { SmartListCriteria } from '@/types/database'

/**
 * POST /api/smart-lists/:id/call-queue — turn a Smart List into a call queue.
 *
 * Resolves the list's current membership and creates one `list_call` human task
 * per lead, which then surfaces in the /tasks queue for staff to work. Reuses
 * the smart-list resolver (membership), createHumanTask (dedupe + insert) and
 * resolveAssignee (routing) — this route is the on-demand producer that ties
 * them together.
 *
 * Dedupe: re-running on the same list collapses onto existing open/claimed
 * tasks (key `list_call:<listId>:<leadId>`), so clicking twice is safe.
 *
 * Defaults: only leads with a phone are queued (a call task with no phone is
 * dead weight); tasks route to a claimable team/role queue.
 */

// One request creates tasks per-row (createHumanTask does 1–2 queries each and
// must target the partial unique index, so a set-based upsert can't be used).
// Cap a single invocation well inside the function timeout; larger lists page
// by re-running (dedupe makes repeats idempotent).
const MAX_CAP = 500
// Bound fan-out so hundreds of inserts don't open hundreds of connections.
const INSERT_CONCURRENCY = 20

const callQueueSchema = z.object({
  assignee_mode: z.enum(['team', 'user']).default('team'),
  assigned_to: z.string().uuid().optional(),
  assigned_role: z.string().min(1).optional(),
  due_at: z.string().datetime().optional(),
  note: z.string().max(500).optional(),
  include_without_phone: z.boolean().default(false),
  cap: z.number().int().positive().optional(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: smartListId } = await params
  const supabase = await createClient()

  // Generating a call queue over a whole list is an agency-side bulk action.
  const guard = await requirePermission(supabase, 'bulk_actions:write')
  if ('error' in guard) return guard.error
  const { orgId } = guard

  const parsed = callQueueSchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }
  const body = parsed.data

  if (body.assignee_mode === 'user' && !body.assigned_to) {
    return NextResponse.json(
      { error: 'assigned_to is required when assignee_mode is "user"' },
      { status: 400 }
    )
  }

  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')
  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Verify the Smart List belongs to the caller's org.
  const { data: smartList } = await supabase
    .from('smart_lists')
    .select('id, name, criteria')
    .eq('id', smartListId)
    .eq('organization_id', orgId)
    .single()

  if (!smartList) {
    return NextResponse.json({ error: 'Smart List not found' }, { status: 404 })
  }

  // Phone-gate by default: reuse the resolver's has_phone criterion.
  const baseCriteria = (smartList.criteria ?? {}) as SmartListCriteria
  const criteria: SmartListCriteria = body.include_without_phone
    ? baseCriteria
    : { ...baseCriteria, has_phone: true }

  const cap = Math.min(body.cap ?? MAX_CAP, MAX_CAP)
  const { leadIds, count } = await resolveSmartListLeads(supabase, orgId, criteria, {
    limit: cap,
  })

  if (leadIds.length === 0) {
    return NextResponse.json({ created: 0, deduped: 0, total: 0, capped: false })
  }

  // Resolve the assignee ONCE and apply it to every task (keeps this set-based
  // rather than one owner lookup per lead).
  let assignedTo: string | null = null
  let assignedRole: string | null = null
  if (body.assignee_mode === 'user') {
    // Only assign to an active user in this org; otherwise fall back to a queue.
    const { data: assignee } = await supabase
      .from('user_profiles')
      .select('id, role')
      .eq('id', body.assigned_to!)
      .eq('organization_id', orgId)
      .eq('is_active', true)
      .maybeSingle()
    if (!assignee) {
      return NextResponse.json(
        { error: 'assigned_to is not an active user in this organization' },
        { status: 400 }
      )
    }
    assignedTo = assignee.id
    assignedRole = (assignee.role as string) ?? null
  } else {
    const resolved = await resolveAssignee(supabase, orgId, null, body.assigned_role ?? 'admin')
    assignedTo = resolved.userId // null → claimable role queue
    assignedRole = resolved.role
  }

  // Nicer titles ("Call Jane") without N decrypt lookups — first_name is a
  // plaintext lead column, so one batched select covers the whole queue.
  const nameById = new Map<string, string>()
  const { data: nameRows } = await supabase
    .from('leads')
    .select('id, first_name')
    .eq('organization_id', orgId)
    .in('id', leadIds)
  for (const r of nameRows || []) {
    const first = (r as { id: string; first_name: string | null }).first_name?.trim()
    if (first) nameById.set((r as { id: string }).id, first)
  }

  const note = body.note?.trim() || null

  let created = 0
  let deduped = 0

  // Bounded-concurrency fan-out over the resolved leads.
  for (let i = 0; i < leadIds.length; i += INSERT_CONCURRENCY) {
    const chunk = leadIds.slice(i, i + INSERT_CONCURRENCY)
    const results = await Promise.all(
      chunk.map((leadId) =>
        createHumanTask(supabase, {
          organization_id: orgId,
          kind: 'list_call',
          source: 'call_queue',
          title: nameById.has(leadId) ? `Call ${nameById.get(leadId)}` : 'Call lead',
          detail: note,
          lead_id: leadId,
          assigned_to: assignedTo,
          assigned_role: assignedRole,
          due_at: body.due_at ?? null,
          dedupe_key: taskDedupeKeyForListCall(smartListId, leadId),
          source_smart_list_id: smartListId,
          created_by: profile.id,
          metadata: { smart_list_id: smartListId, smart_list_name: smartList.name },
        })
      )
    )
    for (const r of results) {
      if (r.taskId && r.deduped) deduped++
      else if (r.taskId) created++
    }
  }

  return NextResponse.json({
    created,
    deduped,
    total: leadIds.length,
    capped: count > leadIds.length,
  })
}
