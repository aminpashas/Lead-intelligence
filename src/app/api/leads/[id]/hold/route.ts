/**
 * PUT/DELETE /api/leads/[id]/hold — set or clear a lead's hold.
 *
 * A hold pauses outbound automation on a lead until a given date (see
 * src/lib/leads/hold.ts for the choke point every send/dial path reads). This
 * route is the only human-facing entry: PUT sets/refreshes the hold and mints
 * the callback task, DELETE clears it early. Expiry itself is swept by
 * task-sweep.ts — this route only handles explicit staff action.
 */
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { decryptField } from '@/lib/encryption'
import { setLeadHold, clearLeadHold } from '@/lib/automation/hold-tasks'
import { leadDisplayName } from '@/lib/leads/display-name'

const putSchema = z.object({
  holdUntil: z.string().datetime(),
  reason: z.string().trim().max(500).nullable().optional(),
})

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = putSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  if (new Date(parsed.data.holdUntil).getTime() <= Date.now()) {
    return NextResponse.json({ error: 'hold_must_be_future' }, { status: 400 })
  }

  // Confirm the lead exists in this org (RLS + explicit scope = defense in depth).
  const { data: lead } = await supabase
    .from('leads')
    .select('id, organization_id, first_name, last_name, phone_formatted')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

  const leadName = leadDisplayName({
    first_name: decryptField(lead.first_name),
    last_name: decryptField(lead.last_name),
    phone_formatted: decryptField(lead.phone_formatted),
  })

  const res = await setLeadHold(supabase, {
    organizationId: orgId,
    leadId: id,
    leadName,
    holdUntil: parsed.data.holdUntil,
    reason: parsed.data.reason ?? null,
    userId: profile.id,
  })
  if (!res.ok) return NextResponse.json({ error: 'Update failed' }, { status: 500 })

  return NextResponse.json({ ok: true, taskId: res.taskId })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: lead } = await supabase
    .from('leads')
    .select('id, organization_id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

  const res = await clearLeadHold(supabase, {
    organizationId: orgId,
    leadId: id,
    via: 'manual',
    userId: profile.id,
  })
  if (!res.ok) return NextResponse.json({ error: 'Update failed' }, { status: 500 })

  return NextResponse.json({ ok: true })
}
