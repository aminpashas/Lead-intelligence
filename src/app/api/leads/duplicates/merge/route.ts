import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { isAdminRole } from '@/lib/auth/permissions'
import { mergeLeads, MergeError } from '@/lib/leads/merge'

const bodySchema = z.object({
  winnerId: z.string().uuid(),
  loserId: z.string().uuid(),
})

// POST /api/leads/duplicates/merge — consolidate a duplicate into a survivor.
//
// Admin-only. A merge collapses one person's history onto another record and
// hides the loser; that is exactly the irreversible-feeling action the practice
// wants behind the admin gate (it IS reversible via /unmerge, but only an admin
// should trigger it). The heavy lifting — snapshot, repoint, tombstone, audit —
// lives in lib/leads/merge.ts.
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await getOwnProfile(supabase, 'id, role')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isAdminRole(profile.role)) {
    return NextResponse.json(
      { error: 'Only an administrator can merge duplicate leads.' },
      { status: 403 },
    )
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  try {
    const result = await mergeLeads(supabase, {
      organizationId: orgId,
      winnerId: parsed.data.winnerId,
      loserId: parsed.data.loserId,
      actor: { userId: profile.id, source: 'admin_merge' },
    })
    return NextResponse.json({ success: true, ...result })
  } catch (e) {
    if (e instanceof MergeError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'failed' ? 500 : 409
      return NextResponse.json({ error: e.message, code: e.code }, { status })
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Merge failed' },
      { status: 500 },
    )
  }
}
