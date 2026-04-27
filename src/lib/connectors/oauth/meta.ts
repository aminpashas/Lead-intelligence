/**
 * Meta (Facebook) OAuth + Marketing API discovery helpers.
 *
 * The flow — which Meta calls "Facebook Login for Business" or just
 * "Facebook Login" for our purposes — goes like this:
 *
 *   1. Redirect user to https://www.facebook.com/v19.0/dialog/oauth with
 *      the scopes we need for CAPI + Marketing reporting.
 *   2. Meta bounces back with a ?code=... we exchange for a short-lived
 *      user access token (~1–2 hours).
 *   3. We immediately exchange the short-lived token for a long-lived one
 *      that survives ~60 days.
 *   4. We enumerate accessible ad accounts (`/me/adaccounts`) and per-
 *      account Pixels (`/{act_id}/adspixels`).
 *   5. User picks one ad account + pixel in the picker UI. We persist
 *      { pixelId, accessToken, adAccountId, tokenExpiresAt } into
 *      connector_configs.credentials (AES-GCM encrypted).
 *
 * Scopes: `ads_management` + `ads_read` + `business_management`. These
 * require Meta App Review to use with non-test users — add users as
 * testers while you're in development to bypass review.
 */

const META_API_VERSION = 'v19.0'
const META_AUTH_BASE = `https://www.facebook.com/${META_API_VERSION}/dialog/oauth`
const META_GRAPH_BASE = `https://graph.facebook.com/${META_API_VERSION}`

export const META_OAUTH_SCOPES = [
  'ads_management',
  'ads_read',
  'business_management',
  'email',
  'public_profile',
]

export type MetaTokenResponse = {
  access_token: string
  token_type: 'bearer'
  expires_in?: number
}

export type MetaAdAccount = {
  id: string                    // e.g. "act_1234567890"
  accountId: string             // bare digits, no "act_" prefix
  name?: string
  currency?: string
  timezoneName?: string
  accountStatus?: number        // 1 = ACTIVE
  businessName?: string
}

export type MetaPixel = {
  id: string
  name?: string
  lastFiredTime?: string        // ISO timestamp of last event (useful sanity check)
  adAccountId: string           // the account this pixel was listed under
}

function requireAppCreds(): { appId: string; appSecret: string } {
  const appId = process.env.META_APP_ID
  const appSecret = process.env.META_APP_SECRET
  if (!appId || !appSecret) {
    throw new Error(
      'META_APP_ID and META_APP_SECRET must be set to use the Meta OAuth connector flow'
    )
  }
  return { appId, appSecret }
}

export function metaRedirectUri(request?: Request): string {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return `${process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/api/connectors/oauth/meta/callback`
  }
  if (request) {
    const url = new URL(request.url)
    return `${url.origin}/api/connectors/oauth/meta/callback`
  }
  throw new Error('Cannot derive Meta OAuth redirect URI — set NEXT_PUBLIC_APP_URL')
}

export function buildMetaAuthUrl(params: {
  state: string
  redirectUri: string
  scopes?: string[]
}): string {
  const { appId } = requireAppCreds()
  const qs = new URLSearchParams({
    client_id: appId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: (params.scopes ?? META_OAUTH_SCOPES).join(','),
    state: params.state,
    // auth_type=rerequest forces the consent dialog to re-appear even if
    // the user has previously granted the same scopes — useful after a
    // declined permission or when scopes change.
    auth_type: 'rerequest',
  })
  return `${META_AUTH_BASE}?${qs.toString()}`
}

/**
 * Exchange an authorization code for a short-lived user access token.
 */
export async function exchangeMetaAuthCode(params: {
  code: string
  redirectUri: string
}): Promise<MetaTokenResponse> {
  const { appId, appSecret } = requireAppCreds()
  const qs = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    redirect_uri: params.redirectUri,
    code: params.code,
  })
  const res = await fetch(`${META_GRAPH_BASE}/oauth/access_token?${qs.toString()}`, {
    method: 'GET',
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Meta token exchange failed (${res.status}): ${text.slice(0, 300)}`)
  }
  return (await res.json()) as MetaTokenResponse
}

/**
 * Upgrade a short-lived user access token to a long-lived one (~60 days).
 * Long-lived tokens are what we persist — re-authorizing every few hours
 * is not an acceptable UX. Auto-refresh before expiry is a separate
 * concern tracked in settings.token_expires_at.
 */
export async function exchangeForLongLivedToken(shortLivedToken: string): Promise<MetaTokenResponse> {
  const { appId, appSecret } = requireAppCreds()
  const qs = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortLivedToken,
  })
  const res = await fetch(`${META_GRAPH_BASE}/oauth/access_token?${qs.toString()}`, {
    method: 'GET',
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Meta long-lived token exchange failed (${res.status}): ${text.slice(0, 300)}`)
  }
  return (await res.json()) as MetaTokenResponse
}

/**
 * List the ad accounts the connecting user can access. `me/adaccounts`
 * returns everything the user is assigned to, including Business Manager
 * accounts they've been granted access to.
 */
export async function listMetaAdAccounts(accessToken: string): Promise<MetaAdAccount[]> {
  const qs = new URLSearchParams({
    access_token: accessToken,
    fields: 'id,account_id,name,currency,timezone_name,account_status,business{name}',
    limit: '200',
  })
  const res = await fetch(`${META_GRAPH_BASE}/me/adaccounts?${qs.toString()}`)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Meta adaccounts list failed (${res.status}): ${text.slice(0, 300)}`)
  }
  const body = (await res.json()) as {
    data?: Array<{
      id: string
      account_id: string
      name?: string
      currency?: string
      timezone_name?: string
      account_status?: number
      business?: { name?: string }
    }>
  }
  return (body.data || []).map((a) => ({
    id: a.id,
    accountId: a.account_id,
    name: a.name,
    currency: a.currency,
    timezoneName: a.timezone_name,
    accountStatus: a.account_status,
    businessName: a.business?.name,
  }))
}

/**
 * List Pixels visible to a given ad account. Pixels are attached to ad
 * accounts (and Business Managers) — a connecting user may see multiple.
 * Failures for a single ad account are returned as an empty list rather
 * than propagating, so the picker stays usable even if one account is
 * misconfigured.
 */
export async function listMetaPixels(params: {
  accessToken: string
  adAccountId: string            // full "act_..." form
}): Promise<MetaPixel[]> {
  const qs = new URLSearchParams({
    access_token: params.accessToken,
    fields: 'id,name,last_fired_time',
    limit: '50',
  })
  const res = await fetch(`${META_GRAPH_BASE}/${params.adAccountId}/adspixels?${qs.toString()}`)
  if (!res.ok) return []
  const body = (await res.json()) as {
    data?: Array<{ id: string; name?: string; last_fired_time?: string }>
  }
  return (body.data || []).map((p) => ({
    id: p.id,
    name: p.name,
    lastFiredTime: p.last_fired_time,
    adAccountId: params.adAccountId,
  }))
}

/**
 * Best-effort sanity probe: fetch `/me` with the token. Used post-
 * refresh to detect invalidated tokens without making a real API call.
 */
export async function probeMetaToken(accessToken: string): Promise<{ id: string; name?: string } | null> {
  const res = await fetch(`${META_GRAPH_BASE}/me?access_token=${encodeURIComponent(accessToken)}&fields=id,name`)
  if (!res.ok) return null
  return (await res.json()) as { id: string; name?: string }
}
