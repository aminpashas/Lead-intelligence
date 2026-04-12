import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

const bulkTagSchema = z.object({
  lead_ids: z.array(z.string().uuid()).min(1).max(500),
  add_tag_ids: z.array(z.string().uuid()).optional(),
  remove_tag_ids: z.array(z.string().uuid()).optional(),
})

// POST /api/leads/bulk/tags — Bulk add/remove tags
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const body = await request.json()
  const parsed = bulkTagSchema.safeParse(body)

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

  const { lead_ids, add_tag_ids, remove_tag_ids } = parsed.data
  let added = 0
  let removed = 0

  // Bulk add tags
  if (add_tag_ids && add_tag_ids.length > 0) {
    const inserts = lead_ids.flatMap((lead_id) =>
      add_tag_ids.map((tag_id) => ({
        lead_id,
        tag_id,
        organization_id: profile.organization_id,
        tagged_by: profile.id,
      }))
    )

    // Insert in batches of 200
    for (let i = 0; i < inserts.length; i += 200) {
      const batch = inserts.slice(i, i + 200)
      const { data } = await supabase
        .from('lead_tags')
        .upsert(batch, { onConflict: 'lead_id,tag_id', ignoreDuplicates: true })
        .select('id')

      added += data?.length || batch.length
    }
  }

  // Bulk remove tags
  if (remove_tag_ids && remove_tag_ids.length > 0) {
    const { data } = await supabase
      .from('lead_tags')
      .delete()
      .eq('organization_id', profile.organization_id)
      .in('lead_id', lead_ids)
      .in('tag_id', remove_tag_ids)
      .select('id')

    removed = data?.length || 0
  }

  return NextResponse.json({ added, removed })
}
