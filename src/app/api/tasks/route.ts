import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'

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
      due_at,
      claimed_by,
      claimed_at,
      completed_at,
      source,
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
