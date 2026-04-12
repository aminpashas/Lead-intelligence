import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
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

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: smartList, error } = await supabase
    .from('smart_lists')
    .select('*')
    .eq('id', id)
    .eq('organization_id', profile.organization_id)
    .single()

  if (error || !smartList) {
    return NextResponse.json({ error: 'Smart List not found' }, { status: 404 })
  }

  // Refresh lead count
  const { count } = await resolveSmartListLeads(
    supabase,
    profile.organization_id,
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
  const body = await request.json()
  const parsed = updateSmartListSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const updates: Record<string, unknown> = { ...parsed.data }

  // If criteria changed, recalculate lead count
  if (parsed.data.criteria) {
    const { count } = await resolveSmartListLeads(
      supabase,
      profile.organization_id,
      parsed.data.criteria as any,
      { countOnly: true }
    )
    updates.lead_count = count
    updates.last_refreshed_at = new Date().toISOString()
  }

  const { data: smartList, error } = await supabase
    .from('smart_lists')
    .update(updates)
    .eq('id', id)
    .eq('organization_id', profile.organization_id)
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

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { error } = await supabase
    .from('smart_lists')
    .delete()
    .eq('id', id)
    .eq('organization_id', profile.organization_id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
