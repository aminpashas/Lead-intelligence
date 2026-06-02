/**
 * GET /api/connectors/oauth/meta/connect
 *
 * Entry point for "Connect with Meta". Mirrors the Google connect route:
 * mint a random state, persist it in `oauth_states` (provider='meta'),
 * and 302 to Meta's OAuth dialog. The callback finishes the exchange and
 * routes the user to the picker page.
 */

import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { buildMetaAuthUrl, metaRedirectUri } from '@/lib/connectors/oauth/meta'

export async function GET(request: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Agency-owned: only an agency_admin inside a client account may connect.
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

  const state = randomBytes(32).toString('base64url')

  const { error: insertErr } = await supabase
    .from('oauth_states')
    .insert({
      state,
      organization_id: active.orgId,
      user_id: user.id,
      provider: 'meta',
      metadata: {},
    })
  if (insertErr) {
    return errorRedirect(request, `state_insert_failed:${encodeURIComponent(insertErr.message)}`)
  }

  try {
    const redirectUri = metaRedirectUri(request)
    const authUrl = buildMetaAuthUrl({ state, redirectUri })
    return NextResponse.redirect(authUrl)
  } catch (err) {
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
