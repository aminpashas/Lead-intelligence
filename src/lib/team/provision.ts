import { createServiceClient } from '@/lib/supabase/server'
import { getPublicAppUrl } from '@/lib/app-url'

/**
 * The six practice-team roles a staff member can be invited as. Agency staff
 * (`agency_admin`) are provisioned through the separate agency console, not
 * this flow. Mirrors the CHECK constraint on `user_profiles.role`.
 */
export type ProvisionRole =
  | 'doctor_admin'
  | 'doctor'
  | 'nurse'
  | 'assistant'
  | 'treatment_coordinator'
  | 'office_manager'

export interface ProvisionMemberInput {
  email: string
  fullName: string
  role: ProvisionRole
  organizationId: string
  /** user_profiles.id of the admin performing the invite. */
  invitedBy: string
  jobTitle?: string | null
  specialty?: string | null
  phone?: string | null
}

export interface ProvisionMemberResult {
  userId: string
  /** One-time accept-invite URL to email the invitee. Carries a hashed OTP. */
  acceptUrl: string
  profile: Record<string, unknown>
}

/**
 * Privileged team-member provisioner.
 *
 * Runs with the SERVICE ROLE so it can call `auth.admin.*` and bypass RLS +
 * the `user_profiles` privesc guards (which intentionally wave through
 * server-side callers where `auth.uid()` is NULL). The CALLER must authorize
 * the request (admin role + correct org scope) BEFORE invoking this — this
 * function does no permission checking of its own.
 *
 * Steps:
 *  1. Stage a `pending_team_invites` row (email → org + role). Only the service
 *     role can write this table, so a public signup can't forge one.
 *  2. `admin.createUser` (no password). The `handle_auth_user_created` trigger
 *     finds the staged invite by email and inserts the profile directly into
 *     that existing org with the assigned role — NO stray "My Practice" org is
 *     created — then consumes the invite row.
 *  3. Fill in the extra profile fields the trigger doesn't set (job title,
 *     phone, specialty).
 *  4. `admin.generateLink({ type: 'recovery' })` to mint a one-time
 *     set-password token, and return an `/accept-invite` URL carrying it.
 *     `generateLink` sends no email itself, so delivery stays under our control.
 *
 * On any failure after the auth user is created, the orphaned user is deleted
 * (cascading its profile) so a retry isn't blocked by "email already registered".
 */
export async function provisionMember(
  input: ProvisionMemberInput
): Promise<ProvisionMemberResult> {
  const service = createServiceClient()
  const email = input.email.trim().toLowerCase()

  // Stage the invite so the signup trigger places the new user in the right org.
  const { error: stageError } = await service
    .from('pending_team_invites')
    .upsert(
      {
        email,
        organization_id: input.organizationId,
        role: input.role,
        invited_by: input.invitedBy,
      },
      { onConflict: 'email' }
    )
  if (stageError) {
    throw new Error(stageError.message)
  }

  const { data: created, error: createError } = await service.auth.admin.createUser({
    email,
    email_confirm: true, // no password yet — set via the recovery link below
    user_metadata: { full_name: input.fullName },
  })

  if (createError || !created?.user) {
    // Clear the staged invite so it can't leak onto a later signup of this email.
    await service.from('pending_team_invites').delete().eq('email', email)
    throw new Error(createError?.message || 'Failed to create invited user')
  }

  const userId = created.user.id

  try {
    // The trigger already created the profile in the correct org + role (and set
    // invited_by/invited_at). Layer on the fields it doesn't handle.
    const { data: profile, error: profileError } = await service
      .from('user_profiles')
      .update({
        job_title: input.jobTitle ?? null,
        specialty: input.specialty ?? null,
        phone: input.phone ?? null,
        is_active: true,
      })
      .eq('id', userId)
      .select()
      .single()

    if (profileError || !profile) {
      throw new Error(profileError?.message || 'Profile row was not created by the signup trigger')
    }

    const { data: linkData, error: linkError } = await service.auth.admin.generateLink({
      type: 'recovery',
      email: input.email,
    })
    if (linkError || !linkData?.properties?.hashed_token) {
      throw new Error(linkError?.message || 'Invite token was not generated')
    }

    const acceptUrl =
      `${getPublicAppUrl()}/accept-invite` +
      `?token_hash=${encodeURIComponent(linkData.properties.hashed_token)}&type=recovery`

    return { userId, acceptUrl, profile }
  } catch (err) {
    await service.auth.admin.deleteUser(userId).catch(() => undefined)
    throw err instanceof Error ? err : new Error(String(err))
  }
}
