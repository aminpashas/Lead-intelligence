import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAgencyLevel, requireAgencyCapability } from '@/lib/auth/active-org'
import { ASSIGNABLE_ROLES, agencyCan, type PracticeRole } from '@/lib/auth/permissions'
import { provisionMember } from '@/lib/team/provision'

/**
 * Manage a CLIENT PRACTICE's team from the agency console, without having to
 * "enter" the account first. The practice org id is the [id] path param.
 *
 * GET  — list the practice's staff (any agency staffer who can read practices)
 * POST — invite a new practice staffer (manager+ via agency:client_team_manage)
 *
 * Agency staff (role=agency_admin) already have cross-org RLS, so reads use the
 * caller's client; privileged writes go through the service-role provisioner.
 */

/** Confirm the id is a real practice org (not the agency's own home org). */
async function assertPracticeOrg(
  supabase: Awaited<ReturnType<typeof createClient>>,
  practiceOrgId: string,
  agencyOrgId: string
): Promise<{ ok: true; name: string } | { ok: false; res: NextResponse }> {
  if (practiceOrgId === agencyOrgId) {
    return {
      ok: false,
      res: NextResponse.json(
        { error: 'Use the agency team page to manage agency staff' },
        { status: 400 }
      ),
    }
  }
  const { data: org } = await supabase
    .from('organizations')
    .select('id, name')
    .eq('id', practiceOrgId)
    .maybeSingle()
  if (!org) {
    return { ok: false, res: NextResponse.json({ error: 'Practice not found' }, { status: 404 }) }
  }
  return { ok: true, name: org.name as string }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: practiceOrgId } = await params
  const supabase = await createClient()

  const { level, homeOrgId } = await getAgencyLevel(supabase)
  if (!level || !homeOrgId || !agencyCan(level, 'agency:practices_read')) {
    return NextResponse.json({ error: 'Forbidden — agency access required' }, { status: 403 })
  }

  const check = await assertPracticeOrg(supabase, practiceOrgId, homeOrgId)
  if (!check.ok) return check.res

  const { data: members, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('organization_id', practiceOrgId)
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    members,
    practice: { id: practiceOrgId, name: check.name },
    canManage: agencyCan(level, 'agency:client_team_manage'),
  })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: practiceOrgId } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const guard = await requireAgencyCapability(supabase, 'agency:client_team_manage')
  if ('error' in guard) return guard.error
  const { agencyOrgId } = guard

  const check = await assertPracticeOrg(supabase, practiceOrgId, agencyOrgId)
  if (!check.ok) return check.res

  const body = await request.json()
  const { email, full_name, role, job_title, specialty, phone } = body

  if (!email || !full_name || !role) {
    return NextResponse.json(
      { error: 'Missing required fields: email, full_name, role' },
      { status: 400 }
    )
  }

  if (!ASSIGNABLE_ROLES.includes(role as PracticeRole)) {
    return NextResponse.json(
      { error: `Invalid role. Must be one of: ${ASSIGNABLE_ROLES.join(', ')}` },
      { status: 400 }
    )
  }

  const result = await provisionMember({
    orgId: practiceOrgId,
    invitedBy: user.id,
    input: {
      email,
      full_name,
      role,
      job_title: job_title || null,
      specialty: specialty || null,
      phone: phone || null,
    },
  })

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ member: result.member }, { status: 201 })
}
