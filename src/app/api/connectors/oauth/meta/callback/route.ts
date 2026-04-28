/**
 * GET /api/connectors/oauth/meta/callback
 *
 * Receives the OAuth redirect from Meta. Validates state, exchanges the
 * auth code for a short-lived user access token, immediately upgrades to
 * a long-lived (~60 day) token, then enumerates the user's ad accounts
 * and their Pixels. Results are stashed into a rotated `oauth_states`
 * row that the picker UI reads.
 *
 * Ad-account and Pixel enumeration failures are non-fatal: we surface
 * them as errors in the picker so the user can proceed (they may have
 * visibility to just one ad account but its Pixel lookup hit a permission
 * issue — still let them retry or enter the Pixel ID manually later).
 */

import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import {
  exchangeForLongLivedToken,
  exchangeMetaAuthCode,
  listMetaAdAccounts,
  listMetaPixels,
  metaRedirectUri,
  type MetaAdAccount,
  type MetaPixel,
} from '@/lib/connectors/oauth/meta'
import { encryptCredentials } from '@/lib/connectors/crypto'

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const metaError = url.searchParams.get('error')
  const errorReason = url.searchParams.get('error_reason')

  if (metaError) {
    return redirectToConnectors(request, `meta_oauth_denied:${metaError}${errorReason ? `:${errorReason}` : ''}`)
  }
  if (!code || !state) {
    return redirectToConnectors(request, 'meta_oauth_missing_params')
  }

  const supabase = createServiceClient()

  const { data: stateRow, error: stateErr } = await supabase
    .from('oauth_states')
    .select('state, organization_id, user_id, provider, expires_at')
    .eq('state', state)
    .eq('provider', 'meta')
    .maybeSingle()

  if (stateErr || !stateRow) {
    return redirectToConnectors(request, 'meta_oauth_invalid_state')
  }
  if (new Date(stateRow.expires_at).getTime() < Date.now()) {
    await supabase.from('oauth_states').delete().eq('state', state)
    return redirectToConnectors(request, 'meta_oauth_state_expired')
  }

  // 1. Short-lived token
  let shortLived
  try {
    shortLived = await exchangeMetaAuthCode({
      code,
      redirectUri: metaRedirectUri(request),
    })
  } catch (err) {
    return redirectToConnectors(
      request,
      `meta_oauth_exchange_failed:${encodeURIComponent(err instanceof Error ? err.message : 'unknown')}`
    )
  }

  // 2. Long-lived token (~60 days). If this fails we could fall back to
  // the short-lived token, but it'd expire within hours — better to
  // surface the error so the user retries.
  let longLived
  try {
    longLived = await exchangeForLongLivedToken(shortLived.access_token)
  } catch (err) {
    return redirectToConnectors(
      request,
      `meta_long_lived_failed:${encodeURIComponent(err instanceof Error ? err.message : 'unknown')}`
    )
  }

  // 3. Enumerate ad accounts + pixels. Non-fatal.
  let adAccounts: MetaAdAccount[] = []
  let adAccountsError: string | null = null
  try {
    adAccounts = await listMetaAdAccounts(longLived.access_token)
  } catch (err) {
    adAccountsError = err instanceof Error ? err.message : 'ad_accounts_failed'
  }

  // 4. Pixels per account — run in parallel, failures per-account yield
  // empty lists rather than aborting.
  const pixelsByAccount: Record<string, MetaPixel[]> = {}
  await Promise.all(
    adAccounts.map(async (acct) => {
      try {
        pixelsByAccount[acct.id] = await listMetaPixels({
          accessToken: longLived.access_token,
          adAccountId: acct.id,
        })
      } catch {
        pixelsByAccount[acct.id] = []
      }
    })
  )

  // 5. Rotate state, stash discovery payload. Long-lived tokens get an
  // expiry we'll respect in settings so the UI can nudge the user to
  // reconnect before the ~60 day mark.
  const pickerState = randomBytes(32).toString('base64url')
  const tokenExpiresAt = longLived.expires_in
    ? new Date(Date.now() + longLived.expires_in * 1000).toISOString()
    : null

  const encryptedTokens = encryptCredentials({
    access_token: longLived.access_token,
  })

  const { error: insertErr } = await supabase
    .from('oauth_states')
    .insert({
      state: pickerState,
      organization_id: stateRow.organization_id,
      user_id: stateRow.user_id,
      provider: 'meta',
      metadata: {
        stage: 'picker',
        token_type: longLived.token_type,
        token_expires_at: tokenExpiresAt,
        tokens: encryptedTokens,
        ad_accounts: adAccounts,
        ad_accounts_error: adAccountsError,
        pixels_by_account: pixelsByAccount,
      },
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    })

  if (insertErr) {
    return redirectToConnectors(
      request,
      `meta_state_write_failed:${encodeURIComponent(insertErr.message)}`
    )
  }

  await supabase.from('oauth_states').delete().eq('state', state)

  const pickerUrl = new URL('/settings/connectors/meta/select', request.url)
  pickerUrl.searchParams.set('state', pickerState)
  return NextResponse.redirect(pickerUrl)
}

function redirectToConnectors(request: NextRequest, error: string): NextResponse {
  const target = new URL('/settings/connectors', request.url)
  target.searchParams.set('oauth_error', error)
  return NextResponse.redirect(target)
}
