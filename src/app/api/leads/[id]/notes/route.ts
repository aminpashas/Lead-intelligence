import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { recordAudit } from '@/lib/audit/record'

/**
 * Manual team notes on a lead.
 *
 * Notes are `lead_activities` rows with `activity_type = 'note_added'` — the
 * type is already in the table's CHECK constraint and the timeline already
 * renders it, so no new table is needed. Notes are per-lead and readable by the
 * whole team; only the author may edit or delete their own.
 *
 * Edits and deletes are audited explicitly: `lead_activities` is excluded from
 * the row-change audit trigger (see 20260704170000_audit_widen_pattern_redaction),
 * so without these calls an overwritten or deleted note would leave no trace of
 * what it said. Same reason `voice_calls` is audited via recordAudit.
 */

const NOTE_ACTIVITY = 'note_added'
const NOTE_TITLE = 'Note'

const createSchema = z.object({
  body: z.string().trim().min(1, 'Note cannot be empty').max(5000),
})

const updateSchema = z.object({
  note_id: z.string().uuid(),
  body: z.string().trim().min(1, 'Note cannot be empty').max(5000),
})

const deleteSchema = z.object({
  note_id: z.string().uuid(),
})

/** Resolves the caller and confirms the lead belongs to their org. */
async function authorize(
  supabase: Awaited<ReturnType<typeof createClient>>,
  leadId: string,
) {
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const { data: profile } = await getOwnProfile(supabase, 'id')
  if (!profile) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  // Scope the lead to the caller's org (defense-in-depth beyond RLS).
  const { data: lead } = await supabase
    .from('leads')
    .select('id')
    .eq('id', leadId)
    .eq('organization_id', orgId)
    .single()
  if (!lead) return { error: NextResponse.json({ error: 'Lead not found' }, { status: 404 }) }

  return { orgId, userId: profile.id as string, leadId: lead.id as string }
}

/** Loads a note and confirms the caller wrote it. */
async function loadOwnNote(
  supabase: Awaited<ReturnType<typeof createClient>>,
  { noteId, orgId, leadId, userId }: { noteId: string; orgId: string; leadId: string; userId: string },
) {
  const { data: note } = await supabase
    .from('lead_activities')
    .select('id, user_id, description')
    .eq('id', noteId)
    .eq('organization_id', orgId)
    .eq('lead_id', leadId)
    .eq('activity_type', NOTE_ACTIVITY)
    .single()

  if (!note) return { error: NextResponse.json({ error: 'Note not found' }, { status: 404 }) }

  // Notes are team-readable but author-owned: anyone can see them, only the
  // author can change them.
  if (note.user_id !== userId) {
    return { error: NextResponse.json({ error: 'You can only edit your own notes' }, { status: 403 }) }
  }

  return { note }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const auth = await authorize(supabase, id)
  if ('error' in auth) return auth.error

  const parsed = createSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const { data: note, error } = await supabase
    .from('lead_activities')
    .insert({
      organization_id: auth.orgId,
      lead_id: auth.leadId,
      user_id: auth.userId,
      activity_type: NOTE_ACTIVITY,
      title: NOTE_TITLE,
      description: parsed.data.body,
    })
    .select('id, created_at, description, user_id')
    .single()

  if (error || !note) {
    return NextResponse.json({ error: 'Failed to save note' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, note })
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const auth = await authorize(supabase, id)
  if ('error' in auth) return auth.error

  const parsed = updateSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const owned = await loadOwnNote(supabase, {
    noteId: parsed.data.note_id,
    orgId: auth.orgId,
    leadId: auth.leadId,
    userId: auth.userId,
  })
  if ('error' in owned) return owned.error

  // No `.single()`: with no UPDATE policy on lead_activities, RLS filters the
  // row out and the update matches nothing. `.single()` would surface that as a
  // generic 500, blaming the server for what is really a permission denial.
  const { data: updated, error } = await supabase
    .from('lead_activities')
    .update({ description: parsed.data.body })
    .eq('id', parsed.data.note_id)
    .select('id, created_at, description, user_id')

  if (error) {
    return NextResponse.json({ error: 'Failed to update note' }, { status: 500 })
  }
  if (!updated?.length) {
    return NextResponse.json(
      { error: 'Note could not be updated — you may not have permission.' },
      { status: 403 }
    )
  }
  const note = updated[0]

  await recordAudit(supabase, {
    organizationId: auth.orgId,
    action: 'lead_note.updated',
    actor: { actorType: 'user', actorId: auth.userId },
    source: 'api_route',
    resourceType: 'lead_activities',
    resourceId: note.id,
    before: { description: owned.note.description },
    after: { description: parsed.data.body },
    changedFields: ['description'],
    metadata: { lead_id: auth.leadId },
  })

  return NextResponse.json({ ok: true, note })
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const auth = await authorize(supabase, id)
  if ('error' in auth) return auth.error

  const parsed = deleteSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const owned = await loadOwnNote(supabase, {
    noteId: parsed.data.note_id,
    orgId: auth.orgId,
    leadId: auth.leadId,
    userId: auth.userId,
  })
  if ('error' in owned) return owned.error

  // `.select()` so we can count what was actually removed. Without it an RLS
  // denial is indistinguishable from success: Postgres filters the row out, the
  // DELETE matches nothing, and PostgREST returns no error. We would then report
  // ok:true and write a deletion audit event for a row still sitting in the
  // table. `lead_activities` has no DELETE policy today, so this is the live
  // behaviour, not a hypothetical.
  const { data: removed, error } = await supabase
    .from('lead_activities')
    .delete()
    .eq('id', parsed.data.note_id)
    .select('id')

  if (error) {
    return NextResponse.json({ error: 'Failed to delete note' }, { status: 500 })
  }
  if (!removed?.length) {
    return NextResponse.json(
      { error: 'Note could not be deleted — you may not have permission.' },
      { status: 403 }
    )
  }

  // The row is gone for good — lead_activities has no soft-delete column and is
  // excluded from the audit trigger, so this event is the only surviving record
  // of what the note said.
  await recordAudit(supabase, {
    organizationId: auth.orgId,
    action: 'lead_note.deleted',
    actor: { actorType: 'user', actorId: auth.userId },
    source: 'api_route',
    resourceType: 'lead_activities',
    resourceId: parsed.data.note_id,
    before: { description: owned.note.description },
    after: null,
    severity: 'warning',
    metadata: { lead_id: auth.leadId },
  })

  return NextResponse.json({ ok: true })
}
