import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAdminRole } from '@/lib/auth/permissions'

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

  // Fetch all team members in the org
  const { data: members, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('organization_id', profile.organization_id)
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

  // Check if user with this email already exists in the org
  const { data: existing } = await supabase
    .from('user_profiles')
    .select('id')
    .eq('organization_id', profile.organization_id)
    .eq('email', email)
    .single()

  if (existing) {
    return NextResponse.json(
      { error: 'A team member with this email already exists in your organization' },
      { status: 409 }
    )
  }

  // Create auth user via Supabase service role (admin API)
  // We generate a random password; the user will set their own via invite link
  const tempPassword = crypto.randomUUID() + '!Aa1'

  // Use the supabase admin client to create the user
  // NOTE: In production, use the service role key for this
  const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: {
      full_name,
      role,
      organization_id: profile.organization_id,
    },
  })

  if (authError) {
    // If the auth user already exists, try to just add the profile
    if (authError.message.includes('already been registered')) {
      return NextResponse.json(
        { error: 'This email is already registered. The user may need to be added manually.' },
        { status: 409 }
      )
    }
    return NextResponse.json({ error: authError.message }, { status: 500 })
  }

  // Create user profile
  const { data: newProfile, error: profileError } = await supabase
    .from('user_profiles')
    .insert({
      id: authUser.user.id,
      organization_id: profile.organization_id,
      full_name,
      email,
      role,
      job_title: job_title || null,
      specialty: specialty || null,
      phone: phone || null,
      invited_by: user.id,
      invited_at: new Date().toISOString(),
      is_active: true,
    })
    .select()
    .single()

  if (profileError) {
    return NextResponse.json({ error: profileError.message }, { status: 500 })
  }

  return NextResponse.json({ member: newProfile }, { status: 201 })
}
