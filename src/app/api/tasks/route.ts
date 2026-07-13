import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { createHumanTask } from '@/lib/automation/tasks'

/**
 * GET /api/tasks — List human tasks for the caller's org (Workstream D2).
 *
 * Query params:
 *   status   open | claimed | done | expired | taken_by_ai | dismissed | active
 *            ('active' = open + claimed; default 'active')
 *   assignee me | all  (default 'all'; 'me' = assigned to or claimed by caller)
 *   kind     inbound_reply | first_touch | nurture_step | stage_automation |
 *            recommendation | sla_breach_review
 *   limit    1..100 (default 50), offset >= 0 (default 0)
 *
 * Response: { tasks, total, openCount, limit, offset }
 * `openCount` is the org-wide live (open+claimed) count for the nav badge,
 * independent of the filters applied to `tasks`.
 */

const VALID_STATUSES = ['open', 'claimed', 'done', 'expired', 'taken_by_ai', 'dismissed', 'active']
const VALID_KINDS = [
  'inbound_reply',
  'first_touch',
  'nurture_step',
  'stage_automation',
  'recommendation',
  'sla_breach_review',
  'call_review',
  'list_call',
  'manual',
]

export async function GET(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()

  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')
  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const statusParam = url.searchParams.get('status') || 'active'
  const status = VALID_STATUSES.includes(statusParam) ? statusParam : 'active'
  const kindParam = url.searchParams.get('kind')
  const kind = kindParam && VALID_KINDS.includes(kindParam) ? kindParam : null
  const assignee = url.searchParams.get('assignee') === 'me' ? 'me' : 'all'

  const rawLimit = parseInt(url.searchParams.get('limit') || '50', 10)
  const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 50 : rawLimit, 1), 100)
  const rawOffset = parseInt(url.searchParams.get('offset') || '0', 10)
  const offset = Math.max(Number.isNaN(rawOffset) ? 0 : rawOffset, 0)

  let query = supabase
    .from('human_tasks')
    .select(
      `
      id,
      kind,
      title,
      detail,
      ai_draft,
      status,
      assigned_to,
      assigned_role,
      priority,
      due_at,
      claimed_by,
      claimed_at,
      completed_at,
      source,
      created_by,
      lead_id,
      conversation_id,
      metadata,
      created_at
    `,
      { count: 'exact' }
    )
    .eq('organization_id', orgId)

  if (status === 'active') {
    query = query.in('status', ['open', 'claimed'])
  } else {
    query = query.eq('status', status)
  }
  if (kind) query = query.eq('kind', kind)
  if (assignee === 'me') {
    query = query.or(`assigned_to.eq.${profile.id},claimed_by.eq.${profile.id}`)
  }

  // Tasks with an SLA deadline surface first (soonest due), then newest.
  const { data: tasks, count, error } = await query
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Org-wide live count for the sidebar badge (independent of filters).
  const { count: openCount } = await supabase
    .from('human_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .in('status', ['open', 'claimed'])

  return NextResponse.json({
    tasks: tasks || [],
    total: count || 0,
    openCount: openCount || 0,
    limit,
    offset,
  })
}

/**
 * POST /api/tasks — Hand-create a manual task (kind='manual').
 *
 * Body: { title, detail?, priority?, due_at?, assigned_to?, lead_id? }
 *   title       required, 1..200 chars
 *   priority    low | normal | high | urgent (default 'normal')
 *   due_at      ISO timestamp (the deadline), or null
 *   assigned_to a user_profiles.id in the caller's org, or null (unassigned)
 *   lead_id     optionally link the task to a lead (adds an "Open" link)
 *
 * Any authenticated org member may create a task; RLS scopes it to the org.
 * assigned_to / lead_id are validated to belong to the same org before insert.
 */

const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  detail: z.string().trim().max(4000).optional().nullable(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  due_at: z.string().datetime({ offset: true }).optional().nullable(),
  assigned_to: z.string().uuid().optional().nullable(),
  lead_id: z.string().uuid().optional().nullable(),
})

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()

  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')
  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = createTaskSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 }
    )
  }
  const { title, detail, priority, due_at, assigned_to, lead_id } = parsed.data

  // The assignee must be an active user in this org (defence-in-depth: RLS
  // scopes the task row, but assigned_to is a bare FK with no org check).
  if (assigned_to) {
    const { data: assignee } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('id', assigned_to)
      .eq('organization_id', orgId)
      .eq('is_active', true)
      .maybeSingle()
    if (!assignee) {
      return NextResponse.json({ error: 'Assignee not found in your organization' }, { status: 400 })
    }
  }

  // A linked lead must belong to the org too.
  if (lead_id) {
    const { data: lead } = await supabase
      .from('leads')
      .select('id')
      .eq('id', lead_id)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!lead) {
      return NextResponse.json({ error: 'Lead not found in your organization' }, { status: 400 })
    }
  }

  const { taskId } = await createHumanTask(supabase, {
    organization_id: orgId,
    kind: 'manual',
    source: 'manual',
    title,
    detail: detail ?? null,
    priority,
    due_at: due_at ?? null,
    assigned_to: assigned_to ?? null,
    lead_id: lead_id ?? null,
    created_by: profile.id,
  })

  if (!taskId) {
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, taskId }, { status: 201 })
}
