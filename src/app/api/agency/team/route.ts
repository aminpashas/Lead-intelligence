import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAgencyLevel, requireAgencyCapability } from '@/lib/auth/active-org'
import { ASSIGNABLE_AGENCY_LEVELS, type AgencyAccessLevel } from '@/lib/auth/permissions'
import { provisionMember } from '@/lib/team/provision'

/**
 * GET  /api/agency/team — list agency staff (role=agency_admin in the agency org)
 * POST /api/agency/team — invite a new agency staffer (owner only)
 *
 * "Agency staff" all share role=agency_admin; the owner/manager/analyst tier is
 * carried in agency_access_level. The agency org is the caller's own home org.
 */

export async function GET() {
  const supabase = await createClient()

  // Any agency staffer may view the roster; the tier limits apply to writes.
  const { level, homeOrgId } = await getAgencyLevel(supabase)
  if (!level || !homeOrgId) {
    return NextResponse.json({ error: 'Forbidden — agency access required' }, { status: 403 })
  }

  const { data: members, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('organization_id', homeOrgId)
    .eq('role', 'agency_admin')
    .order('created_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ members, viewerLevel: level })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Managing agency staff is owner-only.
  const guard = await requireAgencyCapability(supabase, 'agency:team_manage')
  if ('error' in guard) return guard.error
  const { agencyOrgId } = guard

  const body = await request.json()
  const { email, full_name, agency_access_level, job_title, phone } = body

  if (!email || !full_name || !agency_access_level) {
    return NextResponse.json(
      { error: 'Missing required fields: email, full_name, agency_access_level' },
      { status: 400 }
    )
  }

  if (!ASSIGNABLE_AGENCY_LEVELS.includes(agency_access_level as AgencyAccessLevel)) {
    return NextResponse.json(
      { error: `Invalid access level. Must be one of: ${ASSIGNABLE_AGENCY_LEVELS.join(', ')}` },
      { status: 400 }
    )
  }

  const result = await provisionMember({
    orgId: agencyOrgId,
    invitedBy: user.id,
    input: {
      email,
      full_name,
      role: 'agency_admin',
      agency_access_level: agency_access_level as AgencyAccessLevel,
      job_title: job_title || null,
      phone: phone || null,
    },
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  return NextResponse.json({ member: result.member }, { status: 201 })
}
