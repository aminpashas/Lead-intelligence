/**
 * POST /api/audit/[id]/undo — revert the field changes recorded by one audit event.
 *
 * Undo is a FORWARD action. audit_events is append-only (the WORM trigger
 * blocks UPDATE/DELETE outright), so this never rewrites history: it writes
 * the old values back onto the live row, which produces its own `*.update`
 * trigger event, and additionally records an explicit `audit.undo` event
 * pointing at the reverted one. The original event stays untouched.
 *
 * Refusals are deliberate and specific (409): stale rows, protected fields,
 * and system-maintained fields each get their own message so staff know why
 * nothing happened rather than assuming the button is broken. See
 * lib/audit/undo.ts for the guard rationale.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requirePermission, getOwnProfile } from '@/lib/auth/active-org'
import type { Permission } from '@/lib/auth/permissions'
import { computeUndoPlan, UNDOABLE_RESOURCES } from '@/lib/audit/undo'
import { recordAudit } from '@/lib/audit/record'
import { withAuditActor } from '@/lib/audit/actor'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  // Read access to the trail is the floor; the per-resource write permission
  // is checked below, once we know which table the event touched.
  const guard = await requirePermission(supabase, 'broadcast_audit:read')
  if ('error' in guard) return guard.error
  const orgId = guard.orgId

  const { data: event } = await supabase
    .from('audit_events')
    .select('id,action,resource_type,resource_id,before,after,changed_fields,occurred_at')
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle()

  if (!event) {
    return NextResponse.json({ error: 'Audit event not found.' }, { status: 404 })
  }

  const resource = event.resource_type ? UNDOABLE_RESOURCES[event.resource_type] : undefined
  if (!resource || !event.resource_id) {
    return NextResponse.json(
      { error: `Undo is not available for ${event.resource_type ?? 'this record'}.` },
      { status: 409 }
    )
  }

  // Undoing a change to a lead requires the same permission as editing one.
  const writeGuard = await requirePermission(supabase, resource.permission as Permission)
  if ('error' in writeGuard) return writeGuard.error

  const { data: current } = await supabase
    .from(event.resource_type!)
    .select('*')
    .eq('id', event.resource_id)
    .eq('organization_id', orgId)
    .maybeSingle()

  if (!current) {
    return NextResponse.json(
      { error: `That ${resource.label} no longer exists.` },
      { status: 409 }
    )
  }

  const result = computeUndoPlan({
    action: event.action,
    resourceType: event.resource_type,
    before: event.before,
    after: event.after,
    changedFields: event.changed_fields,
    current,
  })

  if (!result.ok) {
    return NextResponse.json(
      { error: result.refusal.message, reason: result.refusal.reason },
      { status: 409 }
    )
  }

  const { data: profile } = await getOwnProfile(supabase, 'id,full_name,email')
  const actorName = profile?.full_name || profile?.email || 'Unknown user'

  // Name the actor on the session so the trigger-generated *.update event this
  // write produces is attributed to a person, not to bare 'system'.
  await withAuditActor(supabase, {
    actorType: 'user',
    actorId: profile?.id ?? null,
    actorLabel: actorName,
  })

  const { error: updateError } = await supabase
    .from(event.resource_type!)
    .update(result.plan.patch)
    .eq('id', event.resource_id)
    .eq('organization_id', orgId)

  if (updateError) {
    return NextResponse.json(
      { error: `Could not undo: ${updateError.message}` },
      { status: 500 }
    )
  }

  await recordAudit(supabase, {
    organizationId: orgId,
    action: 'audit.undo',
    actor: { actorType: 'user', actorId: profile?.id ?? null, actorLabel: actorName },
    source: 'api_route',
    resourceType: event.resource_type,
    resourceId: event.resource_id,
    changedFields: result.plan.reverted,
    severity: 'warning',
    metadata: {
      undone_event_id: event.id,
      undone_event_action: event.action,
      undone_event_occurred_at: event.occurred_at,
      reverted_fields: result.plan.reverted,
      skipped_fields: result.plan.skipped,
    },
  })

  return NextResponse.json({
    ok: true,
    reverted: result.plan.reverted,
    skipped: result.plan.skipped,
    message: `Reverted ${result.plan.reverted.join(', ')} on this ${resource.label}.`,
  })
}
