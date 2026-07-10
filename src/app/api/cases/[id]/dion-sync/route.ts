import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { hasPermission } from '@/lib/auth/permissions'
import { syncDionSurgeryStatusForCase } from '@/lib/treatment/dion-surgery-sync'

/**
 * POST /api/cases/[id]/dion-sync — on-demand read-back of this case's surgery
 * status from Dion Clinical (the same sync the cron runs, triggered from the
 * case detail's Routing section). Caches onto the treatment_closing.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single()
  if (!profile || !hasPermission(profile.role, 'cases:read')) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  // Confirm the case belongs to the active org before syncing (defense in depth).
  const { data: caseRow } = await supabase
    .from('clinical_cases')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle()
  if (!caseRow) return NextResponse.json({ error: 'Case not found' }, { status: 404 })

  const outcome = await syncDionSurgeryStatusForCase(supabase, id)
  return NextResponse.json({ outcome })
}
