import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

const addTagsSchema = z.object({
  tag_ids: z.array(z.string().uuid()).min(1),
})

const removeTagsSchema = z.object({
  tag_ids: z.array(z.string().uuid()).min(1),
})

// POST /api/leads/:id/tags — Add tags to a lead
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: leadId } = await params
  const supabase = await createClient()
  const body = await request.json()
  const parsed = addTagsSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Verify lead belongs to org
  const { data: lead } = await supabase
    .from('leads')
    .select('id')
    .eq('id', leadId)
    .eq('organization_id', profile.organization_id)
    .single()

  if (!lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  // Insert lead_tags (ignore duplicates)
  const inserts = parsed.data.tag_ids.map((tag_id) => ({
    lead_id: leadId,
    tag_id,
    organization_id: profile.organization_id,
    tagged_by: profile.id,
  }))

  const { error } = await supabase
    .from('lead_tags')
    .upsert(inserts, { onConflict: 'lead_id,tag_id', ignoreDuplicates: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: profile.organization_id,
    lead_id: leadId,
    user_id: profile.id,
    activity_type: 'tagged',
    title: `Tags added`,
    metadata: { tag_ids: parsed.data.tag_ids },
  })

  // Fetch updated tags for this lead
  const { data: leadTags } = await supabase
    .from('lead_tags')
    .select('*, tag:tags(*)')
    .eq('lead_id', leadId)
    .eq('organization_id', profile.organization_id)

  return NextResponse.json({ lead_tags: leadTags || [] })
}

// DELETE /api/leads/:id/tags — Remove tags from a lead
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: leadId } = await params
  const supabase = await createClient()
  const body = await request.json()
  const parsed = removeTagsSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { error } = await supabase
    .from('lead_tags')
    .delete()
    .eq('lead_id', leadId)
    .eq('organization_id', profile.organization_id)
    .in('tag_id', parsed.data.tag_ids)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: profile.organization_id,
    lead_id: leadId,
    user_id: profile.id,
    activity_type: 'tagged',
    title: `Tags removed`,
    metadata: { removed_tag_ids: parsed.data.tag_ids },
  })

  // Fetch updated tags
  const { data: leadTags } = await supabase
    .from('lead_tags')
    .select('*, tag:tags(*)')
    .eq('lead_id', leadId)
    .eq('organization_id', profile.organization_id)

  return NextResponse.json({ lead_tags: leadTags || [] })
}
