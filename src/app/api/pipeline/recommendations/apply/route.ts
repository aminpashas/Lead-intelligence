import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg, requirePermission } from '@/lib/auth/active-org'
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
 *
 * EXCEPTION — `autoApply: true` (bulk_stage only): skips the review hand-off and
 * moves the leads' `stage_id` directly. A stage move is not an outbound message,
 * so no consent/A2P gate applies — but it DOES mutate many leads at once, so it
 * requires the `bulk_actions:write` permission (stricter than the review path)
 * and is capped + audited. Broadcasts are never auto-applied.
 */

const applySchema = z.object({
  segmentName: z.string().min(1).max(100),
  actionType: z.enum(['broadcast', 'bulk_stage']),
  channel: z.enum(['sms']).optional(),
  toStageSlug: z.string().optional(),
  criteria: smartListCriteriaSchema,
  /** bulk_stage only: move leads immediately instead of handing off for review. */
  autoApply: z.boolean().optional(),
})

/** Ceiling on a single auto-apply run — a guard against a mis-scoped segment
 *  silently moving the entire book. Segments larger than this are reported as
 *  `capped` so the caller knows the move was partial. TUNE ME per practice. */
const AUTO_APPLY_CAP = 5000
const AUTO_APPLY_PAGE = 500

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
  const { segmentName, actionType, toStageSlug, criteria, autoApply } = parsed.data

  if (autoApply && actionType !== 'bulk_stage') {
    return NextResponse.json(
      { error: 'autoApply is only supported for stage moves' },
      { status: 400 }
    )
  }

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
  const { data: stage } = toStageSlug
    ? await supabase
        .from('pipeline_stages')
        .select('id, name')
        .eq('organization_id', orgId)
        .eq('slug', toStageSlug)
        .maybeSingle()
    : { data: null }

  // ── Auto-apply: move the leads now, no review hand-off. ─────────────────────
  if (autoApply) {
    // Stricter gate than the review path — this mutates many leads directly.
    const guard = await requirePermission(supabase, 'bulk_actions:write')
    if ('error' in guard) return guard.error
    if (!stage?.id) {
      return NextResponse.json({ error: `Unknown stage "${toStageSlug ?? ''}"` }, { status: 400 })
    }

    // Re-resolve the first page each iteration (offset 0): every moved lead
    // leaves the segment (criteria filters on the OLD stage), so the next page
    // is always fresh unmoved leads. That also makes a shifting-window bug
    // impossible. The iteration ceiling is a belt-and-suspenders infinite-loop
    // guard on top of AUTO_APPLY_CAP.
    let moved = 0
    const maxIterations = Math.ceil(AUTO_APPLY_CAP / AUTO_APPLY_PAGE) + 1
    for (let i = 0; i < maxIterations && moved < AUTO_APPLY_CAP; i++) {
      const { leadIds } = await resolveSmartListLeads(supabase, orgId, criteria, {
        limit: AUTO_APPLY_PAGE,
      })
      if (leadIds.length === 0) break

      const { error: updErr } = await supabase
        .from('leads')
        .update({ stage_id: stage.id })
        .in('id', leadIds)
        .eq('organization_id', orgId)
      if (updErr) {
        return NextResponse.json(
          { error: updErr.message, moved, partial: true },
          { status: 500 }
        )
      }

      // One activity-trail row per lead so each move is auditable and visible on
      // the lead timeline (mirrors how manual stage changes are recorded).
      await supabase.from('lead_activities').insert(
        leadIds.map((leadId) => ({
          organization_id: orgId,
          lead_id: leadId,
          activity_type: 'stage_changed',
          title: `Moved to ${stage.name} by pipeline recommendation`,
          metadata: {
            to_stage_id: stage.id,
            source: 'pipeline_recommendation',
            segment: segmentName,
          },
        }))
      )

      moved += leadIds.length
      if (leadIds.length < AUTO_APPLY_PAGE) break
    }

    // No silent truncation: tell the caller when the segment exceeded the cap.
    const capped = moved >= AUTO_APPLY_CAP && count > moved
    return NextResponse.json({
      smartListId,
      autoApplied: true,
      moved,
      total: count,
      capped,
      toStageId: stage.id,
      toStageName: stage.name,
    })
  }

  const stageParam = stage?.id ? `&action=change_stage&stage=${stage.id}` : ''
  return NextResponse.json({
    smartListId,
    leadCount: count,
    redirect: `/campaigns/audiences?list=${smartListId}${stageParam}`,
  })
}
