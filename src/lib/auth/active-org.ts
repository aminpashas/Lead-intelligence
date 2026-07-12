/**
 * Effective-organization resolver (server-side).
 *
 * Mirrors the SQL logic in `get_user_org_id()` (migration 038) for code paths
 * that set `organization_id` explicitly rather than relying on RLS defaults —
 * notably the connector and OAuth routes, which write the org id into rows.
 *
 * An `agency_admin` who has "entered" a client account (a row in
 * `agency_active_org`) resolves to that client's org id. Everyone else — and an
 * agency admin who hasn't entered an account — resolves to their own home org.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import {
  hasPermission,
  agencyCan,
  resolveAgencyLevel,
  type Permission,
  type AgencyAccessLevel,
  type AgencyCapability,
} from '@/lib/auth/permissions'

export type ActiveOrg = {
  /** The org the current request should operate on (active client or home). */
  orgId: string | null
  /** The caller's role from their profile. */
  role: string | null
  /** True when an agency admin is currently acting inside a client account. */
  actingAsClient: boolean
  /** The caller's own home organization (their profile.organization_id). */
  homeOrgId: string | null
}

/**
 * The caller's own `user_profiles` row (or `{ data: null }` when there is no
 * authenticated user / profile).
 *
 * `user_profiles`' SELECT policy is org-scoped ("Users can view profiles in
 * their organization"), NOT self-scoped — so a bare `.single()` matches every
 * staff profile in the org and fails with PGRST116 (surfacing as
 * `data: null`) as soon as the org has a second member, which reads as
 * "unauthenticated" and blanks pages / 401s routes. Fetching one's own
 * profile must always filter by the auth user's id; use this helper.
 */
export async function getOwnProfile(
  supabase: SupabaseClient,
  columns: string
  // Callers pick columns dynamically, so rows come back untyped.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ data: any }> {
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { data: null }
  }

  const { data } = await supabase
    .from('user_profiles')
    .select(columns)
    .eq('id', user.id)
    .maybeSingle()

  return { data }
}

/**
 * Resolve the effective organization for the authenticated session.
 * Returns nulls when there is no authenticated user / profile.
 */
export async function resolveActiveOrg(
  supabase: SupabaseClient
): Promise<ActiveOrg> {
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { orgId: null, role: null, actingAsClient: false, homeOrgId: null }
  }

  // Must filter by the caller's id — see getOwnProfile. (Not routed through
  // it only to reuse the getUser() result for the agency lookup below.)
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile) {
    return { orgId: null, role: null, actingAsClient: false, homeOrgId: null }
  }

  const homeOrgId = profile.organization_id as string
  const role = profile.role as string

  if (role === 'agency_admin') {
    const { data: active } = await supabase
      .from('agency_active_org')
      .select('active_org_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (active?.active_org_id) {
      return {
        orgId: active.active_org_id as string,
        role,
        actingAsClient: true,
        homeOrgId,
      }
    }
  }

  return { orgId: homeOrgId, role, actingAsClient: false, homeOrgId }
}

/**
 * Guard for agency-owned routes (marketing connectors). Only an agency_admin
 * who has entered a client account may proceed, and the returned `orgId` is
 * that client's. Returns a ready-to-send NextResponse on any failure:
 *   401 not authenticated · 403 not an agency admin · 409 no client entered.
 *
 * Usage:
 *   const guard = await requireAgencyClientOrg(supabase)
 *   if ('error' in guard) return guard.error
 *   const { orgId } = guard
 */
export async function requireAgencyClientOrg(
  supabase: SupabaseClient
): Promise<{ orgId: string } | { error: NextResponse }> {
  const active = await resolveActiveOrg(supabase)
  if (!active.role) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  if (active.role !== 'agency_admin') {
    return { error: NextResponse.json({ error: 'Forbidden — agency access required' }, { status: 403 }) }
  }
  if (!active.actingAsClient || !active.orgId) {
    return {
      error: NextResponse.json(
        { error: 'Enter a client account to manage its connectors' },
        { status: 409 }
      ),
    }
  }
  return { orgId: active.orgId }
}

/**
 * Permission guard for API routes. Nav hiding (canAccessRoute) is a courtesy;
 * this is the boundary. Any route whose action is permission-scoped (mass
 * sends, campaign launches, bulk actions, AI config) must call this rather
 * than trusting that the UI never exposed the button.
 *
 * Resolves the effective org (honoring an agency admin's entered client) and
 * checks the caller's role against the RBAC map. Returns a ready-to-send
 * NextResponse on failure: 401 not authenticated · 403 lacking permission.
 *
 * Usage:
 *   const guard = await requirePermission(supabase, 'mass_sms:write')
 *   if ('error' in guard) return guard.error
 *   const { orgId, role } = guard
 */
export async function requirePermission(
  supabase: SupabaseClient,
  permission: Permission
): Promise<{ orgId: string; role: string } | { error: NextResponse }> {
  const active = await resolveActiveOrg(supabase)
  if (!active.role || !active.orgId) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  if (!hasPermission(active.role, permission)) {
    return {
      error: NextResponse.json(
        { error: 'Your role does not allow this action. Ask your agency contact.' },
        { status: 403 }
      ),
    }
  }
  return { orgId: active.orgId, role: active.role }
}

/**
 * Resolve the caller's effective agency access level (owner / manager /
 * analyst), or null if they are not agency staff. Reads role +
 * agency_access_level from the caller's own profile; a legacy agency_admin with
 * no explicit level resolves to 'owner' (see resolveAgencyLevel).
 */
export async function getAgencyLevel(
  supabase: SupabaseClient
): Promise<{ level: AgencyAccessLevel | null; homeOrgId: string | null }> {
  const { data } = await getOwnProfile(supabase, 'organization_id, role, agency_access_level')
  if (!data) return { level: null, homeOrgId: null }
  return {
    level: resolveAgencyLevel(data.role, data.agency_access_level),
    homeOrgId: (data.organization_id as string) ?? null,
  }
}

/**
 * Guard for agency-console capabilities (owner/manager/analyst tiers). Any
 * agency staffer has `role = 'agency_admin'` at the DB layer, so this is the
 * application-layer boundary that separates the tiers — call it in every agency
 * route whose action is not available to all agency staff.
 *
 * Returns the caller's level + their home (agency) org on success, or a
 * ready-to-send NextResponse: 401 not agency staff · 403 lacking the capability.
 *
 * Usage:
 *   const guard = await requireAgencyCapability(supabase, 'agency:team_manage')
 *   if ('error' in guard) return guard.error
 *   const { level, agencyOrgId } = guard
 */
export async function requireAgencyCapability(
  supabase: SupabaseClient,
  capability: AgencyCapability
): Promise<
  | { level: AgencyAccessLevel; agencyOrgId: string }
  | { error: NextResponse }
> {
  const { level, homeOrgId } = await getAgencyLevel(supabase)
  if (!level || !homeOrgId) {
    return { error: NextResponse.json({ error: 'Forbidden — agency access required' }, { status: 403 }) }
  }
  if (!agencyCan(level, capability)) {
    return {
      error: NextResponse.json(
        { error: 'Your agency access level does not allow this action.' },
        { status: 403 }
      ),
    }
  }
  return { level, agencyOrgId: homeOrgId }
}

/** Error codes surfaced as `?oauth_error=` on the connectors settings page. */
export type ConnectorPickerError =
  | 'unauthorized'
  | 'forbidden'
  | 'no_active_account'
  | 'state_org_mismatch'

export type ConnectorPickerAccess =
  | { ok: true; orgId: string }
  | { ok: false; error: ConnectorPickerError }

/**
 * Pure access gate for the OAuth picker pages
 * (`/settings/connectors/{google,meta}/select`).
 *
 * The connector flow is agency-owned: only an `agency_admin` who has entered a
 * client account may finish connecting, and the pending `oauth_state` row must
 * belong to THAT client — not the admin's home org and not blindly accepted.
 * This mirrors `requireAgencyClientOrg` (the POST finalize guard) so the picker
 * page and the route it submits to can never drift apart.
 *
 * Kept pure/dependency-free (like `postLoginPath`) so it can be unit-tested and
 * shared by the two server-component pages without pulling in Supabase or Next.
 */
export function evaluateConnectorPickerAccess({
  role,
  actingAsClient,
  activeOrgId,
  stateOrgId,
}: {
  role: string | null
  actingAsClient: boolean
  activeOrgId: string | null
  stateOrgId: string | null
}): ConnectorPickerAccess {
  if (!role) {
    return { ok: false, error: 'unauthorized' }
  }
  if (role !== 'agency_admin') {
    return { ok: false, error: 'forbidden' }
  }
  if (!actingAsClient || !activeOrgId) {
    return { ok: false, error: 'no_active_account' }
  }
  // CSRF/ownership: the state must belong to the client the admin is currently
  // inside. Compare against the EFFECTIVE acting org, never accept blindly.
  if (stateOrgId !== activeOrgId) {
    return { ok: false, error: 'state_org_mismatch' }
  }
  return { ok: true, orgId: activeOrgId }
}
