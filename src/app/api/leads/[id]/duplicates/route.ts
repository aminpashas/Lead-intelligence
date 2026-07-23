import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { isAdminRole } from '@/lib/auth/permissions'
import { findDuplicateCandidates } from '@/lib/leads/duplicate-detection'
import { leadDisplayName } from '@/lib/leads/display-name'

// GET /api/leads/[id]/duplicates — plausible duplicates of this lead, scored.
//
// Read-only and available to any staff member (it exposes only names + which
// signals matched, never decrypted contact values). The `canMerge` flag tells
// the client whether to render the merge control — merging itself is gated to
// admins in the merge route, so this is a UI hint, not the authorization.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await getOwnProfile(supabase, 'id, role')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // The banner only wants pairs worth interrupting someone over — 'medium' and
  // up (a shared phone/email/identity, or phone+name). Name-only noise is
  // dropped here; the review-task sweep is even stricter ('high').
  const candidates = await findDuplicateCandidates(supabase, orgId, id, {
    minConfidence: 'medium',
  })

  return NextResponse.json({
    canMerge: isAdminRole(profile.role),
    candidates: candidates.map((c) => ({
      id: c.id,
      name: leadDisplayName({
        first_name: c.first_name,
        last_name: c.last_name,
        phone_formatted: null,
      }),
      status: c.status,
      created_at: c.created_at,
      signals: c.pair.signals,
      confidence: c.pair.confidence,
      score: c.pair.score,
    })),
  })
}
