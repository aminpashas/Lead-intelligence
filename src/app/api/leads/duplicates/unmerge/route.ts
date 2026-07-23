import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { isAdminRole } from '@/lib/auth/permissions'
import { unmergeLeads, MergeError } from '@/lib/leads/merge'

const bodySchema = z.object({ archiveId: z.string().uuid() })

// POST /api/leads/duplicates/unmerge — reverse a merge from its archive row.
// Admin-only; restores the loser's timeline, identities and pre-merge state.
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await getOwnProfile(supabase, 'id, role')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isAdminRole(profile.role)) {
    return NextResponse.json(
      { error: 'Only an administrator can reverse a merge.' },
      { status: 403 },
    )
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed' }, { status: 400 })
  }

  try {
    const result = await unmergeLeads(supabase, {
      organizationId: orgId,
      archiveId: parsed.data.archiveId,
      actor: { userId: profile.id, source: 'admin_unmerge' },
    })
    return NextResponse.json({ success: true, ...result })
  } catch (e) {
    if (e instanceof MergeError) {
      const status = e.code === 'not_found' ? 404 : 500
      return NextResponse.json({ error: e.message, code: e.code }, { status })
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Un-merge failed' },
      { status: 500 },
    )
  }
}
