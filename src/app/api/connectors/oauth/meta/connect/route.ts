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
import { buildMetaAuthUrl, metaRedirectUri } from '@/lib/connectors/oauth/meta'

export async function GET(request: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .single()

  if (!profile) {
    return errorRedirect(request, 'unauthorized')
  }
  if (!['owner', 'admin'].includes(profile.role)) {
    return errorRedirect(request, 'forbidden')
  }

  const state = randomBytes(32).toString('base64url')

  const { error: insertErr } = await supabase
    .from('oauth_states')
    .insert({
      state,
      organization_id: profile.organization_id,
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
