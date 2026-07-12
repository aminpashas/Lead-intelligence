import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAgencyCapability } from '@/lib/auth/active-org'
import { ASSIGNABLE_ROLES, isAdminRole, type PracticeRole } from '@/lib/auth/permissions'
import { updateMember } from '@/lib/team/provision'

/**
 * PATCH  /api/agency/practices/[id]/team/[memberId] — edit a practice staffer
 * DELETE /api/agency/practices/[id]/team/[memberId] — deactivate a practice staffer
 *
 * Manager+ (agency:client_team_manage). Enforces the practice's own last-admin
 * protection so the agency can't accidentally lock a client out of its account.
 */

async function loadTarget(
  supabase: Awaited<ReturnType<typeof createClient>>,
  memberId: string,
  practiceOrgId: string
) {
  const { data } = await supabase
    .from('user_profiles')
    .select('id, organization_id, role, is_active')
    .eq('id', memberId)
    .maybeSingle()
  if (!data || data.organization_id !== practiceOrgId) return null
  return data
}

const PRACTICE_ADMIN_ROLES = ['doctor_admin', 'office_manager', 'owner', 'admin']

/** True if deactivating/demoting this admin would leave the practice with none. */
async function wouldOrphanPracticeAdmins(
  supabase: Awaited<ReturnType<typeof createClient>>,
  practiceOrgId: string,
  targetId: string,
  targetRole: string
): Promise<boolean> {
  if (!PRACTICE_ADMIN_ROLES.includes(targetRole)) return false
  const { count } = await supabase
    .from('user_profiles')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', practiceOrgId)
    .eq('is_active', true)
    .in('role', PRACTICE_ADMIN_ROLES)
  void targetId
  return (count ?? 0) <= 1
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> }
) {
  const { id: practiceOrgId, memberId } = await params
  const supabase = await createClient()

  const guard = await requireAgencyCapability(supabase, 'agency:client_team_manage')
  if ('error' in guard) return guard.error
  const { agencyOrgId } = guard
  if (practiceOrgId === agencyOrgId) {
    return NextResponse.json({ error: 'Use the agency team page to manage agency staff' }, { status: 400 })
  }

  const target = await loadTarget(supabase, memberId, practiceOrgId)
  if (!target) return NextResponse.json({ error: 'Member not found' }, { status: 404 })

  const body = await request.json()
  const { role, job_title, specialty, phone, is_active, full_name } = body

  if (role !== undefined && !ASSIGNABLE_ROLES.includes(role as PracticeRole)) {
    return NextResponse.json(
      { error: `Invalid role. Must be one of: ${ASSIGNABLE_ROLES.join(', ')}` },
      { status: 400 }
    )
  }

  // Guard the practice's last admin against demotion / deactivation.
  const demotingAdmin =
    role !== undefined && isAdminRole(target.role) && !isAdminRole(role)
  const deactivating = is_active === false
  if ((demotingAdmin || deactivating) &&
      (await wouldOrphanPracticeAdmins(supabase, practiceOrgId, memberId, target.role))) {
    return NextResponse.json(
      { error: "Cannot remove the practice's last active admin" },
      { status: 409 }
    )
  }

  const updates: Record<string, unknown> = {}
  if (role !== undefined) updates.role = role
  if (job_title !== undefined) updates.job_title = job_title
  if (specialty !== undefined) updates.specialty = specialty
  if (phone !== undefined) updates.phone = phone
  if (is_active !== undefined) updates.is_active = is_active
  if (full_name !== undefined) updates.full_name = full_name

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const result = await updateMember({ memberId, updates })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ member: result.member })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> }
) {
  const { id: practiceOrgId, memberId } = await params
  const supabase = await createClient()

  const guard = await requireAgencyCapability(supabase, 'agency:client_team_manage')
  if ('error' in guard) return guard.error
  const { agencyOrgId } = guard
  if (practiceOrgId === agencyOrgId) {
    return NextResponse.json({ error: 'Use the agency team page to manage agency staff' }, { status: 400 })
  }

  const target = await loadTarget(supabase, memberId, practiceOrgId)
  if (!target) return NextResponse.json({ error: 'Member not found' }, { status: 404 })

  if (await wouldOrphanPracticeAdmins(supabase, practiceOrgId, memberId, target.role)) {
    return NextResponse.json(
      { error: "Cannot remove the practice's last active admin" },
      { status: 409 }
    )
  }

  const result = await updateMember({ memberId, updates: { is_active: false } })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ success: true })
}
