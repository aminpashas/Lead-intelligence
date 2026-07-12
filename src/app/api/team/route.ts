import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAdminRole } from '@/lib/auth/permissions'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { provisionMember } from '@/lib/team/provision'

/**
 * GET /api/team — List all team members in the current org
 * POST /api/team — Invite a new team member
 */

export async function GET() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get caller's profile
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  }

  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Fetch all team members in the org
  const { data: members, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ members })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get caller's profile and check admin
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()

  if (!profile || !isAdminRole(profile.role)) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 })
  }

  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { email, full_name, role, job_title, specialty, phone } = body

  if (!email || !full_name || !role) {
    return NextResponse.json(
      { error: 'Missing required fields: email, full_name, role' },
      { status: 400 }
    )
  }

  // Validate role
  const validRoles = [
    'doctor_admin', 'doctor', 'nurse', 'assistant',
    'treatment_coordinator', 'office_manager',
  ]
  if (!validRoles.includes(role)) {
    return NextResponse.json(
      { error: `Invalid role. Must be one of: ${validRoles.join(', ')}` },
      { status: 400 }
    )
  }

  // Provision via the shared service-role helper. Creating the auth user
  // requires the service role key (admin API) — doing it on the authed client
  // silently fails in production — and the service client also cleanly bypasses
  // the user_profiles privesc INSERT trigger now that the route has authorized
  // the caller (admin) and validated the role.
  const result = await provisionMember({
    orgId,
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

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  return NextResponse.json({ member: result.member }, { status: 201 })
}
