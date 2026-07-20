import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { z } from 'zod'
import { resolveSmartListLeads } from '@/lib/campaigns/smart-list-resolver'

const updateSmartListSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  icon: z.string().max(50).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  criteria: z.record(z.string(), z.unknown()).optional(),
  is_pinned: z.boolean().optional(),
})

// GET /api/smart-lists/:id — Get a Smart List with refreshed count
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await getOwnProfile(supabase, 'organization_id')

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: smartList, error } = await supabase
    .from('smart_lists')
    .select('*')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (error || !smartList) {
    return NextResponse.json({ error: 'Smart List not found' }, { status: 404 })
  }

  // Refresh lead count
  const { count } = await resolveSmartListLeads(
    supabase,
    orgId,
    smartList.criteria,
    { countOnly: true }
  )

  // Update cached count
  if (count !== smartList.lead_count) {
    await supabase
      .from('smart_lists')
      .update({ lead_count: count, last_refreshed_at: new Date().toISOString() })
      .eq('id', id)
  }

  return NextResponse.json({
    smart_list: { ...smartList, lead_count: count },
  })
}

// PATCH /api/smart-lists/:id — Update a Smart List
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json()
  const parsed = updateSmartListSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { data: profile } = await getOwnProfile(supabase, 'organization_id')

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const updates: Record<string, unknown> = { ...parsed.data }

  // If criteria changed, recalculate lead count
  if (parsed.data.criteria) {
    // The builder edits filters wholesale and doesn't know about manual
    // removals — carry existing excluded_lead_ids forward unless the payload
    // sets the key itself (an explicit [] clears them via the exclusions API).
    if (!('excluded_lead_ids' in parsed.data.criteria)) {
      const { data: existing } = await supabase
        .from('smart_lists')
        .select('criteria')
        .eq('id', id)
        .eq('organization_id', orgId)
        .single()
      const prior = (existing?.criteria as { excluded_lead_ids?: string[] } | null)
        ?.excluded_lead_ids
      if (prior && prior.length > 0) {
        updates.criteria = { ...parsed.data.criteria, excluded_lead_ids: prior }
      }
    }

    const { count } = await resolveSmartListLeads(
      supabase,
      orgId,
      updates.criteria as any,
      { countOnly: true }
    )
    updates.lead_count = count
    updates.last_refreshed_at = new Date().toISOString()
  }

  const { data: smartList, error } = await supabase
    .from('smart_lists')
    .update(updates)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ smart_list: smartList })
}

// DELETE /api/smart-lists/:id — Delete a Smart List
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await getOwnProfile(supabase, 'organization_id')

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { error } = await supabase
    .from('smart_lists')
    .delete()
    .eq('id', id)
    .eq('organization_id', orgId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
