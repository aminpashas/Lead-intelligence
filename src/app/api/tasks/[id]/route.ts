import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'

/**
 * PATCH /api/tasks/[id] — Claim, complete, or dismiss a human task (D2).
 *
 * Body: { action: 'claim' | 'complete' | 'dismiss' }
 *   claim    open            → claimed  (sets claimed_by/claimed_at to caller)
 *   complete open | claimed  → done     (sets completed_at; credits caller as
 *                                        claimer if nobody had claimed it)
 *   dismiss  open | claimed  → dismissed
 *
 * Permissions mirror the escalations queue: any authenticated org member can
 * work the queue (RLS scopes rows to the org). A task claimed by someone else
 * can't be claimed again (409).
 */

const taskPatchSchema = z.object({
  action: z.enum(['claim', 'complete', 'dismiss']),
})

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 })
  }

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

  const parsed = taskPatchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 }
    )
  }
  const { action } = parsed.data

  // Verify the task belongs to the caller's org and read its current state.
  const { data: task } = await supabase
    .from('human_tasks')
    .select('id, status, claimed_by')
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle()

  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  const now = new Date().toISOString()
  const updates: Record<string, unknown> = { updated_at: now }

  switch (action) {
    case 'claim':
      if (task.status !== 'open') {
        return NextResponse.json(
          { error: `Cannot claim a task in status "${task.status}"` },
          { status: 409 }
        )
      }
      updates.status = 'claimed'
      updates.claimed_by = profile.id
      updates.claimed_at = now
      break
    case 'complete':
      if (task.status !== 'open' && task.status !== 'claimed') {
        return NextResponse.json(
          { error: `Cannot complete a task in status "${task.status}"` },
          { status: 409 }
        )
      }
      updates.status = 'done'
      updates.completed_at = now
      // Credit the completer as claimer when nobody had claimed the task.
      if (!task.claimed_by) {
        updates.claimed_by = profile.id
        updates.claimed_at = now
      }
      break
    case 'dismiss':
      if (task.status !== 'open' && task.status !== 'claimed') {
        return NextResponse.json(
          { error: `Cannot dismiss a task in status "${task.status}"` },
          { status: 409 }
        )
      }
      updates.status = 'dismissed'
      updates.completed_at = now
      break
  }

  const { data: updated, error } = await supabase
    .from('human_tasks')
    .update(updates)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('id, status, claimed_by, claimed_at, completed_at')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, action, task: updated })
}
