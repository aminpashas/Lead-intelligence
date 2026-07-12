/**
 * Shared member provisioning + deactivation mechanics.
 *
 * These helpers perform the PRIVILEGED writes (create the auth user, insert /
 * update the user_profiles row) using the service-role client — which runs with
 * `auth.uid()` NULL, so it bypasses RLS and the privilege-escalation triggers
 * (20260627 / 20260707). That is safe ONLY because the calling route has already
 * authorized the actor. Never call these from a path that hasn't verified the
 * caller may manage the target org's team.
 */

import { createServiceClient } from '@/lib/supabase/server'
import type { UserProfile } from '@/types/database'

export type ProvisionInput = {
  email: string
  full_name: string
  role: string
  /** Only meaningful when role === 'agency_admin'. */
  agency_access_level?: 'owner' | 'manager' | 'analyst' | null
  job_title?: string | null
  specialty?: string | null
  phone?: string | null
}

export type ProvisionResult =
  | { ok: true; member: UserProfile }
  | { ok: false; status: number; error: string }

/**
 * Create a new team member in `orgId`. Idempotency: rejects if a profile with
 * the same email already exists in the org (409). Creates the Supabase auth user
 * with a random password (the member sets their own via the invite/reset flow).
 */
export async function provisionMember(params: {
  orgId: string
  invitedBy: string
  input: ProvisionInput
}): Promise<ProvisionResult> {
  const { orgId, invitedBy, input } = params
  const svc = createServiceClient()

  // Reject duplicate within the org.
  const { data: existing } = await svc
    .from('user_profiles')
    .select('id')
    .eq('organization_id', orgId)
    .eq('email', input.email)
    .maybeSingle()

  if (existing) {
    return { ok: false, status: 409, error: 'A member with this email already exists in this organization' }
  }

  // Create the auth user (service role). Random password → the user sets their
  // own via the invite / password-reset flow.
  const tempPassword = crypto.randomUUID() + '!Aa1'
  const { data: authUser, error: authError } = await svc.auth.admin.createUser({
    email: input.email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: {
      full_name: input.full_name,
      role: input.role,
      organization_id: orgId,
    },
  })

  if (authError || !authUser?.user) {
    if (authError?.message?.includes('already been registered')) {
      return {
        ok: false,
        status: 409,
        error: 'This email is already registered. The user may need to be added manually.',
      }
    }
    return { ok: false, status: 500, error: authError?.message ?? 'Failed to create auth user' }
  }

  const { data: newProfile, error: profileError } = await svc
    .from('user_profiles')
    .insert({
      id: authUser.user.id,
      organization_id: orgId,
      full_name: input.full_name,
      email: input.email,
      role: input.role,
      agency_access_level: input.role === 'agency_admin' ? input.agency_access_level ?? 'owner' : null,
      job_title: input.job_title ?? null,
      specialty: input.specialty ?? null,
      phone: input.phone ?? null,
      invited_by: invitedBy,
      invited_at: new Date().toISOString(),
      is_active: true,
    })
    .select()
    .single()

  if (profileError) {
    // Roll back the orphaned auth user so a retry can succeed cleanly.
    await svc.auth.admin.deleteUser(authUser.user.id).catch(() => {})
    return { ok: false, status: 500, error: profileError.message }
  }

  return { ok: true, member: newProfile as UserProfile }
}

/**
 * Apply a partial update to a member (service role). The caller must have
 * authorized both the actor and the specific fields being changed.
 */
export async function updateMember(params: {
  memberId: string
  updates: Record<string, unknown>
}): Promise<ProvisionResult> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('user_profiles')
    .update(params.updates)
    .eq('id', params.memberId)
    .select()
    .single()

  if (error) return { ok: false, status: 500, error: error.message }
  return { ok: true, member: data as UserProfile }
}
