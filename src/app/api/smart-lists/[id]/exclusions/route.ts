import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { resolveSmartListLeads } from '@/lib/campaigns/smart-list-resolver'
import type { SmartListCriteria } from '@/types/database'

/**
 * POST /api/smart-lists/:id/exclusions — manually remove a lead from a Smart
 * List (or undo a removal).
 *
 * Smart Lists are criteria-driven, so there is no membership row to delete —
 * "remove" means appending the lead to `criteria.excluded_lead_ids`, which the
 * resolver applies as a NOT IN on top of every other filter. The read-modify-
 * write happens here (not in the client) so concurrent removals merge instead
 * of clobbering each other's criteria.
 *
 * The lead itself is untouched: no stage move, no status change — it simply
 * stops matching this one list.
 */

const bodySchema = z.object({
  leadId: z.string().uuid(),
  /** 'exclude' removes the lead from the list; 'include' undoes a removal. */
  action: z.enum(['exclude', 'include']).default('exclude'),
})

/** Same cap as criteria.excluded_lead_ids in the validator (PostgREST not-in limit). */
const MAX_EXCLUSIONS = 1000

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }
  const { leadId, action } = parsed.data

  const { data: smartList, error } = await supabase
    .from('smart_lists')
    .select('id, criteria')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  if (error || !smartList) {
    return NextResponse.json({ error: 'Smart List not found' }, { status: 404 })
  }

  const criteria = (smartList.criteria ?? {}) as SmartListCriteria
  const current = new Set(criteria.excluded_lead_ids ?? [])

  if (action === 'exclude') {
    if (current.size >= MAX_EXCLUSIONS && !current.has(leadId)) {
      return NextResponse.json(
        { error: `This list already has ${MAX_EXCLUSIONS} manual removals — edit the filters instead.` },
        { status: 400 }
      )
    }
    current.add(leadId)
  } else {
    current.delete(leadId)
  }

  const nextCriteria: SmartListCriteria = { ...criteria }
  if (current.size > 0) nextCriteria.excluded_lead_ids = [...current]
  else delete nextCriteria.excluded_lead_ids

  const { count } = await resolveSmartListLeads(supabase, orgId, nextCriteria, {
    countOnly: true,
  })

  const { error: updateError } = await supabase
    .from('smart_lists')
    .update({
      criteria: nextCriteria,
      lead_count: count,
      last_refreshed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('organization_id', orgId)
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    excluded: action === 'exclude',
    excludedCount: current.size,
    leadCount: count,
  })
}
