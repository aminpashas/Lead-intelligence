/**
 * GET /api/connectors/oauth/google/connect
 *
 * Kicks off the Google OAuth consent flow for the combined Ads + GA4
 * integration. The flow is:
 *
 *   1. User clicks "Connect with Google" on /settings/connectors.
 *   2. This route authenticates the session, mints a random `state` token,
 *      persists it in `oauth_states` (15-min TTL, scoped to the org+user),
 *      and 302s to Google's authorization URL.
 *   3. Google bounces back to /api/connectors/oauth/google/callback with
 *      the code + state.
 *   4. The callback route verifies state, exchanges the code for tokens,
 *      enumerates accessible Ads customers + GA4 properties, and redirects
 *      the user to the picker UI.
 *
 * Only owners and admins can initiate — matches the existing role gate
 * on the connectors PUT endpoint.
 */

import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { buildGoogleAuthUrl, googleRedirectUri } from '@/lib/connectors/oauth/google'

export async function GET(request: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Connectors are agency-owned: only an agency_admin who has entered a client
  // account may connect, and the credentials are bound to that client org.
  const active = await resolveActiveOrg(supabase)
  if (!active.role) {
    return errorRedirect(request, 'unauthorized')
  }
  if (active.role !== 'agency_admin') {
    return errorRedirect(request, 'forbidden')
  }
  if (!active.actingAsClient || !active.orgId) {
    return errorRedirect(request, 'no_active_account')
  }

  // URL-safe base64, 32 bytes → ~43 chars.
  const state = randomBytes(32).toString('base64url')

  const { error: insertErr } = await supabase
    .from('oauth_states')
    .insert({
      state,
      organization_id: active.orgId,
      user_id: user.id,
      provider: 'google',
      metadata: {},
    })
  if (insertErr) {
    return errorRedirect(request, `state_insert_failed:${encodeURIComponent(insertErr.message)}`)
  }

  try {
    const redirectUri = googleRedirectUri(request)
    const authUrl = buildGoogleAuthUrl({ state, redirectUri })
    return NextResponse.redirect(authUrl)
  } catch (err) {
    // Missing GOOGLE_ADS_CLIENT_ID / CLIENT_SECRET or NEXT_PUBLIC_APP_URL.
    // Surface as a banner on the settings page, not a raw JSON error.
    return errorRedirect(
      request,
      `not_configured:${encodeURIComponent(err instanceof Error ? err.message : 'unknown')}`
    )
  }
}

function errorRedirect(request: NextRequest, code: string): NextResponse {
  const target = new URL('/settings/connectors', request.url)
  target.searchParams.set('oauth_error', code)
  return NextResponse.redirect(target)
}
