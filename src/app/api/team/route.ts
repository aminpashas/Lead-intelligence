import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAdminRole } from '@/lib/auth/permissions'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { provisionMember, type ProvisionRole } from '@/lib/team/provision'
import { buildInviteEmail } from '@/lib/team/invite-email'
import { sendEmail } from '@/lib/messaging/resend'
import { logger } from '@/lib/logger'

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

  // Check if user with this email already exists in the org
  const { data: existing } = await supabase
    .from('user_profiles')
    .select('id')
    .eq('organization_id', orgId)
    .eq('email', email)
    .single()

  if (existing) {
    return NextResponse.json(
      { error: 'A team member with this email already exists in your organization' },
      { status: 409 }
    )
  }

  // Provision the auth user + org-scoped profile and mint a one-time
  // accept-invite link. Runs with the service role (auth.admin + RLS bypass);
  // this route has already authorized the caller (admin role + org scope).
  let provisioned
  try {
    provisioned = await provisionMember({
      email,
      fullName: full_name,
      role: role as ProvisionRole,
      organizationId: orgId,
      invitedBy: user.id,
      jobTitle: job_title || null,
      specialty: specialty || null,
      phone: phone || null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create team member'
    if (message.toLowerCase().includes('already been registered') || message.toLowerCase().includes('already registered')) {
      return NextResponse.json(
        { error: 'This email is already registered.' },
        { status: 409 }
      )
    }
    return NextResponse.json({ error: message }, { status: 500 })
  }

  // Look up the org + inviter name for a friendlier email.
  const [{ data: org }, { data: inviter }] = await Promise.all([
    supabase.from('organizations').select('name').eq('id', orgId).single(),
    supabase.from('user_profiles').select('full_name').eq('id', user.id).single(),
  ])

  // Send the invitation email. Transactional send — honors DRY-RUN /
  // TEST_SEND_ALLOWLIST clamps, so `sent` may be false in test environments.
  // The one-time link is returned regardless so an admin can copy-and-share.
  let emailSent = false
  try {
    const mail = buildInviteEmail({
      fullName: full_name,
      organizationName: org?.name || 'your practice',
      inviterName: inviter?.full_name || null,
      role: role as ProvisionRole,
      acceptUrl: provisioned.acceptUrl,
    })
    const result = await sendEmail({
      to: email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    })
    emailSent = !result.id.startsWith('blocked') && result.id !== 'dry-run'
  } catch (err) {
    // Don't fail the invite if email delivery hiccups — the account exists and
    // the link is returned for manual delivery.
    logger.warn('Team invite email failed to send', {
      to: email,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return NextResponse.json(
    { member: provisioned.profile, invite_url: provisioned.acceptUrl, email_sent: emailSent },
    { status: 201 }
  )
}
