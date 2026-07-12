import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'

/**
 * POST /api/pipeline/recommendations/[id]/dismiss — server-side dismissal (C2).
 *
 * `id` is the recommendation's DEDUPE KEY ('kind:stageId' or 'analyst:<slug>',
 * URL-encoded — it contains a colon), which is what the band component has for
 * both live-computed and persisted recs (`rec.id`). A raw row UUID is also
 * accepted for API callers holding one. Marks the matching OPEN row
 * status='dismissed' with acted_by='human' + who/when, which:
 *   - removes it from the page read (listOpenRecommendations filters 'open'),
 *   - prevents the hourly sync from resurrecting it this cycle (a NEW open row
 *     appears only if the segment still fires on a later run — by design:
 *     dismissal is "not now", not "never"),
 *   - enters it into the outcome-measurement control group.
 *
 * No matching open row (live-computed rec, or already acted on) is NOT an
 * error — the client's optimistic local dismissal stands; respond dismissed:false.
 */

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: rawId } = await params
  const id = decodeURIComponent(rawId ?? '').trim()
  if (!id || id.length > 200) {
    return NextResponse.json({ error: 'Invalid recommendation id' }, { status: 400 })
  }

  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await getOwnProfile(supabase, 'id')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)

  let query = supabase
    .from('pipeline_recommendations')
    .update({
      status: 'dismissed',
      acted_by: 'human',
      acted_by_user: profile.id,
      acted_at: new Date().toISOString(),
    })
    .eq('organization_id', orgId)
    .eq('status', 'open')
  query = isUuid ? query.eq('id', id) : query.eq('dedupe_key', id)

  const { data, error } = await query.select('id')
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ dismissed: (data?.length ?? 0) > 0 })
}
