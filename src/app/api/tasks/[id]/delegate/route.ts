import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { previewDelegation, commitDelegation, type DelegableTask } from '@/lib/tasks/delegation'

/**
 * POST /api/tasks/[id]/delegate — hand a task to the AI ("let the AI do it").
 *
 * Body: { mode: 'preview' | 'commit' }
 *   preview  generate the AI's reply and return the EXACT outbound text for the
 *            human to review (no send, no writes to the patient record).
 *   commit   send the previously previewed text and close the task as
 *            `delegated_to_ai`, attributed to the caller.
 *
 * Any authenticated org member may delegate; RLS scopes the task row to the org.
 * Preview must precede commit — commit sends the stored draft, so calling it
 * without a fresh preview returns 409 'no_preview'.
 */

const bodySchema = z.object({ mode: z.enum(['preview', 'commit']) })

export async function POST(
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

  const { data: profile } = await getOwnProfile(supabase, 'id, full_name, organization_id')
  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }
  const { mode } = parsed.data

  if (mode === 'commit') {
    const result = await commitDelegation(supabase, orgId, id, {
      id: profile.id,
      label: (profile as { full_name?: string | null }).full_name ?? null,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: result.status })
    }
    return NextResponse.json({ ok: true, sent: true, message: result.message, channel: result.channel })
  }

  // mode === 'preview' — needs the task's routing fields for the capability check.
  const { data: task } = await supabase
    .from('human_tasks')
    .select('id, kind, status, lead_id, conversation_id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle()
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  const preview = await previewDelegation(supabase, orgId, task as DelegableTask)
  return NextResponse.json({ ok: true, preview })
}
