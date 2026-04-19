import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAdminRole } from '@/lib/auth/permissions'

/**
 * PATCH /api/team/[id] — Update a team member's role/info
 * DELETE /api/team/[id] — Deactivate a team member
 */

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
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

  // Prevent self-demotion for safety
  if (id === user.id) {
    return NextResponse.json(
      { error: 'You cannot modify your own role' },
      { status: 400 }
    )
  }

  const body = await request.json()
  const { role, job_title, specialty, phone, is_active, full_name } = body

  // Validate role if provided
  if (role) {
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
  }

  // Build update object
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

  // Ensure the target is in the same org
  const { data: target } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .eq('id', id)
    .single()

  if (!target || target.organization_id !== profile.organization_id) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 })
  }

  const { data: updated, error } = await supabase
    .from('user_profiles')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ member: updated })
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

  // Prevent self-deactivation
  if (id === user.id) {
    return NextResponse.json(
      { error: 'You cannot deactivate yourself' },
      { status: 400 }
    )
  }

  // Ensure the target is in the same org
  const { data: target } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .eq('id', id)
    .single()

  if (!target || target.organization_id !== profile.organization_id) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 })
  }

  // Soft-delete: set is_active to false
  const { error } = await supabase
    .from('user_profiles')
    .update({ is_active: false })
    .eq('id', id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
