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
 * Resolve the effective organization for the authenticated session.
 * Returns nulls when there is no authenticated user / profile.
 */
export async function resolveActiveOrg(
  supabase: SupabaseClient
): Promise<ActiveOrg> {
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .single()

  if (!profile) {
    return { orgId: null, role: null, actingAsClient: false, homeOrgId: null }
  }

  const homeOrgId = profile.organization_id as string
  const role = profile.role as string

  if (role === 'agency_admin') {
    const { data: active } = await supabase
      .from('agency_active_org')
      .select('active_org_id')
      .single()

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
