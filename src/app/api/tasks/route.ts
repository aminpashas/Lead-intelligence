import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { createHumanTask } from '@/lib/automation/tasks'
import { renderSweptTask, type SweepLead } from '@/lib/automation/task-sweep'
import { decryptLeadPII } from '@/lib/encryption'
import { leadDisplayName } from '@/lib/leads/display-name'

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
 * Response: { tasks, total, openCount, backlog, limit, offset }
 * `openCount` is the org-wide live (open+claimed) count for the nav badge,
 * independent of the filters applied to `tasks`.
 * `backlog` counts bulk//offboard work that is deliberately NOT minted as tasks
 * (see lib/automation/task-sweep.ts) but must still be visible from /tasks:
 * never-contacted leads (worked via Smart List → call queue) and open AI
 * escalations (which own their own lifecycle in settings/ai).
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
  'follow_up',
  'callback',
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
  // Optional lead scoping (the lead detail page). Malformed ids are ignored
  // rather than erroring, matching how status/kind degrade to defaults.
  const leadIdParam = url.searchParams.get('lead_id')
  const leadId =
    leadIdParam && z.string().uuid().safeParse(leadIdParam).success ? leadIdParam : null

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
      reviewed_at,
      reviewed_by,
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
  if (leadId) query = query.eq('lead_id', leadId)
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

  const hydrated = await hydrateLeadNames(supabase, tasks ?? [])

  // Org-wide live count for the sidebar badge (independent of filters).
  const { count: openCount } = await supabase
    .from('human_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .in('status', ['open', 'claimed'])

  const backlog = await loadBacklog(supabase, orgId)

  return NextResponse.json({
    tasks: hydrated,
    total: count || 0,
    openCount: openCount || 0,
    backlog,
    limit,
    offset,
  })
}

/**
 * Attach each task's lead label, and re-render swept titles from live lead data.
 *
 * `human_tasks.title` is frozen at mint time but the lead under it keeps moving,
 * so the queue accumulated names that were true once and are wrong now. The
 * loudest case was patients listed as phone numbers: a lead whose phone had been
 * parsed into `first_name` minted as "Re-engage -408 724-0003 — gone quiet", and
 * the later phone-name scrub cleaned the lead but could not reach into the task
 * title. Same story for a name a receptionist fixed by hand, or one recovered
 * from GHL/CareStack.
 *
 * Swept tasks carry `metadata.rule`, and every sweep rule's title/detail is a
 * pure function of the lead — so they are simply re-run against the current row
 * (see `renderSweptTask`). Tasks from other producers keep their stored title
 * and just gain `lead.name`, which the UI shows alongside it.
 *
 * Best-effort: a failure here costs a nicer label, never the queue.
 */
type TaskRow = Record<string, unknown> & {
  lead_id?: string | null
  title?: string | null
  detail?: string | null
  metadata?: Record<string, unknown> | null
}

async function hydrateLeadNames(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tasks: TaskRow[]
): Promise<TaskRow[]> {
  const leadIds = [...new Set(tasks.map((t) => t.lead_id).filter(Boolean))] as string[]
  if (leadIds.length === 0) return tasks

  const { data: leadRows } = await supabase
    .from('leads')
    .select(
      'id, first_name, last_name, phone, phone_formatted, last_contacted_at, last_responded_at, created_at, closing_follow_up_at'
    )
    .in('id', leadIds)

  if (!leadRows) return tasks

  // PII is encrypted at rest — `leadDisplayName` must be handed plaintext or it
  // would render the `enc::…` envelope as the patient's name.
  const byId = new Map<string, SweepLead & { id: string }>()
  for (const row of leadRows as Record<string, string | null>[]) {
    const decrypted = decryptLeadPII(row)
    byId.set(row.id as string, {
      id: row.id as string,
      name: leadDisplayName(decrypted),
      last_contacted_at: decrypted.last_contacted_at ?? null,
      last_responded_at: decrypted.last_responded_at ?? null,
      created_at: decrypted.created_at as string,
      closing_follow_up_at: decrypted.closing_follow_up_at ?? null,
    })
  }

  return tasks.map((task) => {
    const lead = task.lead_id ? byId.get(task.lead_id) : undefined
    if (!lead) return task

    const rerendered = renderSweptTask(task.metadata?.rule as string | undefined, lead)
    return {
      ...task,
      ...(rerendered ?? {}),
      lead: { id: lead.id, name: lead.name },
    }
  })
}

/**
 * Counts for the /tasks backlog banner. Best-effort: this is context, never the
 * reason the queue fails to render, so each count independently degrades to 0.
 */
async function loadBacklog(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string
): Promise<{ untouchedNew: number; openEscalations: number }> {
  const [cohort, escalations] = await Promise.all([
    // Reuses the Action Queue's own RPC — asking for 1 row just to read `total`.
    supabase.rpc('get_action_queue_cohort', {
      p_org_id: orgId,
      p_cohort: 'untouched_new',
      p_limit: 1,
      p_offset: 0,
    }),
    supabase
      .from('escalations')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .in('status', ['pending', 'claimed']),
  ])

  return {
    untouchedNew: (cohort.data as { total?: number } | null)?.total ?? 0,
    openEscalations: escalations.count ?? 0,
  }
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
