/**
 * GET /api/connectors/oauth/google/callback
 *
 * Handles the OAuth redirect from Google. Verifies the `state` token we
 * issued in /connect, exchanges the authorization code for tokens,
 * enumerates the user's accessible Google Ads customers and GA4 account
 * summaries, stashes everything into `oauth_states.metadata` (encrypted
 * where sensitive), and redirects to the picker UI so the user can choose
 * which Ads customer and GA4 property to bind.
 *
 * We re-use the same state row to carry the tokens + discovery payload
 * forward to the picker page (instead of writing a half-configured row
 * into `connector_configs`). On picker submit, the final
 * `/select` route writes the real connector_configs rows and drops the
 * state row.
 */

import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import {
  describeAdsCustomer,
  exchangeGoogleAuthCode,
  googleRedirectUri,
  listAccessibleAdsCustomers,
  listGA4AccountSummaries,
  type GoogleAdsAccessibleCustomer,
  type GA4AccountSummary,
} from '@/lib/connectors/oauth/google'
import { encryptCredentials } from '@/lib/connectors/crypto'

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const googleError = url.searchParams.get('error')

  if (googleError) {
    return redirectToConnectors(request, `google_oauth_denied:${googleError}`)
  }
  if (!code || !state) {
    return redirectToConnectors(request, 'google_oauth_missing_params')
  }

  // Use the service client so the callback works even if the user's
  // Supabase session cookie was refreshed during the Google redirect.
  // RLS is bypassed but we still scope every write to the org_id we
  // read from the state row.
  const supabase = createServiceClient()

  const { data: stateRow, error: stateErr } = await supabase
    .from('oauth_states')
    .select('state, organization_id, user_id, provider, expires_at, metadata')
    .eq('state', state)
    .eq('provider', 'google')
    .maybeSingle()

  if (stateErr || !stateRow) {
    return redirectToConnectors(request, 'google_oauth_invalid_state')
  }
  if (new Date(stateRow.expires_at).getTime() < Date.now()) {
    await supabase.from('oauth_states').delete().eq('state', state)
    return redirectToConnectors(request, 'google_oauth_state_expired')
  }

  // Exchange code → tokens.
  let tokens
  try {
    tokens = await exchangeGoogleAuthCode({
      code,
      redirectUri: googleRedirectUri(request),
    })
  } catch (err) {
    return redirectToConnectors(
      request,
      `google_oauth_exchange_failed:${encodeURIComponent(err instanceof Error ? err.message : 'unknown')}`
    )
  }

  if (!tokens.refresh_token) {
    // If we didn't get a refresh_token Google has already granted consent
    // for this user + client. The first /connect route forces prompt=consent
    // to avoid this, but if an external flow has already run we'll fall
    // back to asking the user to remove our app in their Google security
    // settings and retry.
    return redirectToConnectors(request, 'google_oauth_no_refresh_token')
  }

  // Best-effort enumeration of accessible accounts. Failures here are
  // surfaced to the picker UI (user can proceed with whatever succeeded
  // or retry) rather than aborting the whole flow.
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN
  let adsCustomers: GoogleAdsAccessibleCustomer[] = []
  let adsError: string | null = null
  if (developerToken) {
    try {
      const ids = await listAccessibleAdsCustomers({
        accessToken: tokens.access_token,
        developerToken,
      })
      adsCustomers = await Promise.all(
        ids.map((id) =>
          describeAdsCustomer({ accessToken: tokens.access_token, developerToken, customerId: id })
            .then((c) => c ?? { resourceName: `customers/${id}`, customerId: id })
            .catch(() => ({ resourceName: `customers/${id}`, customerId: id }))
        )
      )
    } catch (err) {
      adsError = err instanceof Error ? err.message : 'ads_list_failed'
    }
  } else {
    adsError = 'GOOGLE_ADS_DEVELOPER_TOKEN not configured on server'
  }

  let ga4Accounts: GA4AccountSummary[] = []
  let ga4Error: string | null = null
  try {
    ga4Accounts = await listGA4AccountSummaries(tokens.access_token)
  } catch (err) {
    ga4Error = err instanceof Error ? err.message : 'ga4_list_failed'
  }

  // Rotate the state so the picker UI gets a fresh token. This ensures
  // the callback URL itself is single-use — a back-button reload or
  // accidental share-link leak can't replay the tokens.
  const pickerState = randomBytes(32).toString('base64url')

  // Stash refresh_token + access_token + discovery results in the state
  // row, encrypting the tokens. The picker page reads this, renders the
  // choices, and the /select finalize endpoint promotes everything to
  // proper connector_configs rows before deleting the state row.
  const encryptedTokens = encryptCredentials({
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
  })

  const { error: upsertErr } = await supabase
    .from('oauth_states')
    .insert({
      state: pickerState,
      organization_id: stateRow.organization_id,
      user_id: stateRow.user_id,
      provider: 'google',
      metadata: {
        stage: 'picker',
        scope: tokens.scope,
        expires_in: tokens.expires_in,
        id_token: tokens.id_token ?? null,
        tokens: encryptedTokens,
        ads_customers: adsCustomers,
        ads_error: adsError,
        ga4_accounts: ga4Accounts,
        ga4_error: ga4Error,
      },
      // Give the user 30 minutes to pick (forms can sit open) — still
      // short enough that stolen access_tokens don't linger.
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    })

  if (upsertErr) {
    return redirectToConnectors(request, `google_oauth_state_write_failed:${encodeURIComponent(upsertErr.message)}`)
  }

  // Delete the consumed /connect state row.
  await supabase.from('oauth_states').delete().eq('state', state)

  const pickerUrl = new URL('/settings/connectors/google/select', request.url)
  pickerUrl.searchParams.set('state', pickerState)
  return NextResponse.redirect(pickerUrl)
}

function redirectToConnectors(request: NextRequest, error: string): NextResponse {
  const target = new URL('/settings/connectors', request.url)
  target.searchParams.set('oauth_error', error)
  return NextResponse.redirect(target)
}
