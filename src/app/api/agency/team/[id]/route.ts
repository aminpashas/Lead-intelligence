import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAgencyCapability } from '@/lib/auth/active-org'
import { ASSIGNABLE_AGENCY_LEVELS, type AgencyAccessLevel } from '@/lib/auth/permissions'
import { updateMember } from '@/lib/team/provision'

/**
 * PATCH  /api/agency/team/[id] — change an agency staffer's level / name / status
 * DELETE /api/agency/team/[id] — deactivate an agency staffer
 *
 * Owner-only. Protects against self-modification and against removing the last
 * active owner (which would orphan the agency's control).
 */

async function loadTarget(
  supabase: Awaited<ReturnType<typeof createClient>>,
  id: string,
  agencyOrgId: string
) {
  const { data } = await supabase
    .from('user_profiles')
    .select('id, organization_id, role, agency_access_level, is_active')
    .eq('id', id)
    .maybeSingle()
  if (!data || data.organization_id !== agencyOrgId || data.role !== 'agency_admin') {
    return null
  }
  return data
}

/** Guard: refuse to leave the agency with zero active owners. */
async function wouldOrphanOwners(
  supabase: Awaited<ReturnType<typeof createClient>>,
  agencyOrgId: string,
  targetId: string
): Promise<boolean> {
  const { data: owners } = await supabase
    .from('user_profiles')
    .select('id, agency_access_level')
    .eq('organization_id', agencyOrgId)
    .eq('role', 'agency_admin')
    .eq('is_active', true)
  // Legacy admins (null level) count as owners.
  const activeOwners = (owners ?? []).filter(
    (o) => (o.agency_access_level ?? 'owner') === 'owner'
  )
  return activeOwners.length <= 1 && activeOwners.some((o) => o.id === targetId)
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const guard = await requireAgencyCapability(supabase, 'agency:team_manage')
  if ('error' in guard) return guard.error
  const { agencyOrgId } = guard

  if (id === user.id) {
    return NextResponse.json({ error: 'You cannot modify your own agency access' }, { status: 400 })
  }

  const target = await loadTarget(supabase, id, agencyOrgId)
  if (!target) return NextResponse.json({ error: 'Agency member not found' }, { status: 404 })

  const body = await request.json()
  const { agency_access_level, full_name, phone, is_active } = body

  const updates: Record<string, unknown> = {}

  if (agency_access_level !== undefined) {
    if (!ASSIGNABLE_AGENCY_LEVELS.includes(agency_access_level as AgencyAccessLevel)) {
      return NextResponse.json(
        { error: `Invalid access level. Must be one of: ${ASSIGNABLE_AGENCY_LEVELS.join(', ')}` },
        { status: 400 }
      )
    }
    // Demoting the last owner would orphan the agency.
    if (agency_access_level !== 'owner' && (await wouldOrphanOwners(supabase, agencyOrgId, id))) {
      return NextResponse.json(
        { error: 'Cannot demote the last active Agency Owner' },
        { status: 409 }
      )
    }
    updates.agency_access_level = agency_access_level
  }

  if (full_name !== undefined) updates.full_name = full_name
  if (phone !== undefined) updates.phone = phone
  if (is_active !== undefined) {
    if (is_active === false && (await wouldOrphanOwners(supabase, agencyOrgId, id))) {
      return NextResponse.json(
        { error: 'Cannot deactivate the last active Agency Owner' },
        { status: 409 }
      )
    }
    updates.is_active = is_active
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const result = await updateMember({ memberId: id, updates })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ member: result.member })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const guard = await requireAgencyCapability(supabase, 'agency:team_manage')
  if ('error' in guard) return guard.error
  const { agencyOrgId } = guard

  if (id === user.id) {
    return NextResponse.json({ error: 'You cannot deactivate yourself' }, { status: 400 })
  }

  const target = await loadTarget(supabase, id, agencyOrgId)
  if (!target) return NextResponse.json({ error: 'Agency member not found' }, { status: 404 })

  if (await wouldOrphanOwners(supabase, agencyOrgId, id)) {
    return NextResponse.json(
      { error: 'Cannot deactivate the last active Agency Owner' },
      { status: 409 }
    )
  }

  const result = await updateMember({ memberId: id, updates: { is_active: false } })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ success: true })
}
