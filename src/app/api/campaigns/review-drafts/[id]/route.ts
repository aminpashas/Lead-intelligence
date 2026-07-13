/**
 * PATCH /api/campaigns/review-drafts/[id] — approve or reject a review_first draft.
 *
 * Body: { action: 'approve' | 'reject' }.
 *   • approve → mark approved (guarded pending→approved claim) and send the
 *     stored body through the consent-gated messaging layer.
 *   • reject  → mark rejected; nothing is sent.
 * Both are org-scoped and idempotent (a non-pending row is a no-op / 409-style
 * "already reviewed"), so a double-click can't double-send.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { approveCampaignReviewDraft, rejectCampaignReviewDraft } from '@/lib/campaigns/review-drafts'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await getOwnProfile(supabase, 'id')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { action?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (body.action !== 'approve' && body.action !== 'reject') {
    return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 })
  }

  const result = body.action === 'approve'
    ? await approveCampaignReviewDraft(supabase, orgId, id, profile.id)
    : await rejectCampaignReviewDraft(supabase, orgId, id, profile.id)

  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'Could not process draft' }, { status: 409 })
  }

  return NextResponse.json({ success: true, status: result.status, sent_via: result.sent_via ?? null })
}
