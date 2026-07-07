import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { smartListCriteriaSchema } from '@/lib/validators/smart-list'
import { resolveSmartListLeads } from '@/lib/campaigns/smart-list-resolver'

/**
 * Apply a Pipeline recommendation — REVIEW FIRST.
 *
 * Nothing is sent and no lead is moved here. This endpoint only:
 *   1. Materializes the recommendation's segment as a Smart List (reusing an
 *      existing list with the same name so repeated applies don't pile up).
 *   2. Returns a deep-link to the existing review surface:
 *        - broadcast  → the Mass SMS composer, pre-selected to the segment
 *        - bulk_stage → the Audiences page, segment open with the stage-move
 *          bulk action pre-filled
 *
 * The human confirms the actual send / move on that surface, where the A2P and
 * consent gates live.
 */

const applySchema = z.object({
  segmentName: z.string().min(1).max(100),
  actionType: z.enum(['broadcast', 'bulk_stage']),
  channel: z.enum(['sms']).optional(),
  toStageSlug: z.string().optional(),
  criteria: smartListCriteriaSchema,
})

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = applySchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }
  const { segmentName, actionType, toStageSlug, criteria } = parsed.data

  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Reuse an identically-named list so applying the same recommendation twice
  // refreshes it instead of spawning duplicates.
  const { data: existing } = await supabase
    .from('smart_lists')
    .select('id')
    .eq('organization_id', orgId)
    .eq('name', segmentName)
    .maybeSingle()

  const { count } = await resolveSmartListLeads(supabase, orgId, criteria, {
    countOnly: true,
  })

  let smartListId: string
  if (existing?.id) {
    smartListId = existing.id
    await supabase
      .from('smart_lists')
      .update({
        criteria,
        lead_count: count,
        last_refreshed_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .eq('organization_id', orgId)
  } else {
    const { data: created, error } = await supabase
      .from('smart_lists')
      .insert({
        organization_id: orgId,
        name: segmentName,
        description: 'Auto-created from a Pipeline recommendation',
        icon: 'sparkles',
        color: '#6366F1',
        criteria,
        is_pinned: false,
        lead_count: count,
        last_refreshed_at: new Date().toISOString(),
        created_by: profile.id,
      })
      .select('id')
      .single()
    if (error || !created) {
      return NextResponse.json(
        { error: error?.message ?? 'Failed to create segment' },
        { status: 500 }
      )
    }
    smartListId = created.id
  }

  // Build the review-surface deep-link.
  if (actionType === 'broadcast') {
    return NextResponse.json({
      smartListId,
      leadCount: count,
      redirect: `/campaigns/broadcasts/sms?smart_list_id=${smartListId}`,
    })
  }

  // bulk_stage: resolve the target stage slug to an id in this org.
  let stageParam = ''
  if (toStageSlug) {
    const { data: stage } = await supabase
      .from('pipeline_stages')
      .select('id')
      .eq('organization_id', orgId)
      .eq('slug', toStageSlug)
      .maybeSingle()
    if (stage?.id) stageParam = `&action=change_stage&stage=${stage.id}`
  }
  return NextResponse.json({
    smartListId,
    leadCount: count,
    redirect: `/campaigns/audiences?list=${smartListId}${stageParam}`,
  })
}
