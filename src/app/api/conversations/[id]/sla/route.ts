import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { requirePermission } from '@/lib/auth/active-org'
import { closeSlaOnHumanReply, attemptTakeover, type MessageResponseSla } from '@/lib/automation/sla'

/**
 * /api/conversations/[id]/sla — the thread's human-response SLA countdown.
 *
 * GET  — the PENDING message_response_slas row for this conversation (or
 *        null). Read via the user client so RLS scopes it to the caller's org.
 * POST — { action: 'claim' }  → the human takes the conversation now: close
 *        the timer as human_responded + complete the inbound task
 *        (closeSlaOnHumanReply semantics).
 *        { action: 'ai_now' } → don't wait for the deadline: run the takeover
 *        immediately (attemptTakeover — every safety gate still applies; if a
 *        human reply already landed it closes as human_responded instead).
 *
 * Writes go through the SERVICE client because message_response_slas has no
 * authenticated write policies (writes are service-role only by design) — the
 * org boundary is enforced by first reading the pending row through the
 * user's RLS-scoped client.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const postSchema = z.object({ action: z.enum(['claim', 'ai_now']) })

async function loadPendingSla(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  conversationId: string
) {
  const { data } = await supabase
    .from('message_response_slas')
    .select('id, conversation_id, inbound_at, sla_seconds, deadline_at, status')
    .eq('organization_id', orgId)
    .eq('conversation_id', conversationId)
    .eq('status', 'pending')
    .limit(1)
    .maybeSingle()
  return data ?? null
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const { id } = await params
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid conversation id' }, { status: 400 })
  }

  const supabase = await createClient()
  const guard = await requirePermission(supabase, 'conversations:read')
  if ('error' in guard) return guard.error

  const sla = await loadPendingSla(supabase, guard.orgId, id)
  return NextResponse.json({ sla })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const { id } = await params
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid conversation id' }, { status: 400 })
  }

  const supabase = await createClient()
  const guard = await requirePermission(supabase, 'conversations:write')
  if ('error' in guard) return guard.error

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = postSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'action must be claim or ai_now' }, { status: 400 })
  }

  // RLS-scoped read proves this pending timer belongs to the caller's org
  // before any service-role write touches it.
  const pending = await loadPendingSla(supabase, guard.orgId, id)
  if (!pending) {
    return NextResponse.json({ ok: true, sla: null, outcome: 'no_pending_sla' })
  }

  const service = createServiceClient()

  if (parsed.data.action === 'claim') {
    const {
      data: { user },
    } = await supabase.auth.getUser()
    await closeSlaOnHumanReply(service, id, user?.id ?? null)
    return NextResponse.json({ ok: true, outcome: 'claimed' })
  }

  // ai_now: reload the FULL row (takeover_payload lives outside the RLS read
  // column set) and run the standard takeover path — gates included.
  const { data: fullRow } = await service
    .from('message_response_slas')
    .select('*')
    .eq('id', pending.id)
    .eq('status', 'pending')
    .maybeSingle()

  if (!fullRow) {
    return NextResponse.json({ ok: true, outcome: 'no_pending_sla' })
  }

  const outcome = await attemptTakeover(service, fullRow as MessageResponseSla)
  return NextResponse.json({ ok: true, outcome })
}
