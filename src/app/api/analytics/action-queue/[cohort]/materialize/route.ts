import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import {
  ACTION_QUEUE_COHORTS,
  isActionQueueCohortKey,
  type ActionQueueCohortLead,
} from '@/lib/analytics/deep-types'
import type { SmartListCriteria } from '@/types/database'

/**
 * POST /api/analytics/action-queue/:cohort/materialize — REVIEW FIRST.
 *
 * Pins the cohort's current membership into a Smart List (static lead_ids
 * snapshot, since two of the cohorts are column-to-column SQL predicates no
 * attribute criteria can express) and returns a deep-link to the existing
 * review surface:
 *   target 'sms'      → Mass SMS composer, pre-scoped to the list
 *   target 'email'    → Mass Email composer, pre-scoped to the list
 *   target 'audience' → Audiences page (bulk actions / campaign enrollment)
 *
 * Nothing is sent here — the composers own the A2P, consent, and daily-cap
 * gates. Mirrors /api/pipeline/recommendations/apply: an identically-named
 * list is refreshed instead of duplicated, so re-materializing a cohort
 * updates the snapshot in place.
 */

const bodySchema = z.object({
  target: z.enum(['sms', 'email', 'audience']),
})

/** Snapshot ceiling — matches the smart-list resolver's .in('id', …) cap. */
const SNAPSHOT_CAP = 1000

const REDIRECTS: Record<'sms' | 'email' | 'audience', (id: string) => string> = {
  sms: (id) => `/campaigns/broadcasts/sms?smart_list_id=${id}`,
  email: (id) => `/campaigns/broadcasts/email?smart_list_id=${id}`,
  audience: (id) => `/campaigns/audiences?list=${id}`,
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ cohort: string }> }
) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const { cohort } = await params
  if (!isActionQueueCohortKey(cohort)) {
    return NextResponse.json({ error: `Unknown cohort "${cohort}"` }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }
  const { target } = parsed.data

  const supabase = await createClient()
  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Resolve the cohort's current membership (freshest signal first — the RPC
  // orders by coalesce(last_responded_at, created_at) desc, so when a cohort
  // exceeds the cap we keep the leads most worth reaching).
  const { data, error } = await supabase.rpc('get_action_queue_cohort', {
    p_org_id: orgId,
    p_cohort: cohort,
    p_limit: SNAPSHOT_CAP,
    p_offset: 0,
  })
  if (error) {
    return NextResponse.json(
      { error: `Action-queue cohort RPC failed: ${error.message}` },
      { status: 500 }
    )
  }

  const page = data as { total: number; leads: ActionQueueCohortLead[] }
  const leadIds = page.leads.map((l) => l.id)
  if (leadIds.length === 0) {
    return NextResponse.json({ error: 'Cohort is empty — nothing to materialize' }, { status: 409 })
  }

  const meta = ACTION_QUEUE_COHORTS[cohort]
  const name = `Action Queue: ${meta.label}`
  const criteria: SmartListCriteria = { lead_ids: leadIds }

  // Refresh an identically-named list instead of piling up duplicates.
  const { data: existing } = await supabase
    .from('smart_lists')
    .select('id')
    .eq('organization_id', orgId)
    .eq('name', name)
    .maybeSingle()

  let smartListId: string
  if (existing?.id) {
    smartListId = existing.id
    const { error: updateError } = await supabase
      .from('smart_lists')
      .update({
        criteria,
        lead_count: leadIds.length,
        last_refreshed_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .eq('organization_id', orgId)
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }
  } else {
    const { data: created, error: insertError } = await supabase
      .from('smart_lists')
      .insert({
        organization_id: orgId,
        name,
        description: `Snapshot of the "${meta.label}" Action Center queue — ${meta.description}`,
        icon: 'zap',
        color: '#EF4444',
        criteria,
        is_pinned: false,
        lead_count: leadIds.length,
        last_refreshed_at: new Date().toISOString(),
        created_by: profile.id,
      })
      .select('id')
      .single()
    if (insertError || !created) {
      return NextResponse.json(
        { error: insertError?.message ?? 'Failed to create segment' },
        { status: 500 }
      )
    }
    smartListId = created.id
  }

  // No silent truncation: tell the caller when the cohort exceeded the cap.
  return NextResponse.json({
    smartListId,
    leadCount: leadIds.length,
    total: page.total,
    capped: page.total > leadIds.length,
    redirect: REDIRECTS[target](smartListId),
  })
}
