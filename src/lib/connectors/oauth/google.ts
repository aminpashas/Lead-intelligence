/**
 * Google OAuth + API discovery helpers for the combined Ads + GA4
 * consent flow.
 *
 * The platform app acts as a single OAuth client (`GOOGLE_ADS_CLIENT_ID`
 * / `GOOGLE_ADS_CLIENT_SECRET`). Each org goes through this flow once,
 * we persist their refresh token into `connector_configs.credentials`
 * (encrypted), and subsequently mint short-lived access tokens on demand.
 *
 * Scopes requested in a single consent screen:
 *   - adwords                 → Google Ads API (offline conversions, reporting)
 *   - analytics.readonly      → GA4 Data API + Admin API reads (reporting + property enumeration)
 *   - openid email profile    → to identify the connected Google user for the audit trail
 *
 * The Measurement Protocol API Secret used by our GA4 event sender is
 * *not* covered by these scopes — GA4 requires that to be created
 * manually in the GA4 Admin UI. The picker page prompts for it after
 * OAuth completes.
 */

const GOOGLE_AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_ADS_API_VERSION = 'v18'
const GOOGLE_ADS_LIST_ACCESSIBLE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers:listAccessibleCustomers`
const GOOGLE_ADS_CUSTOMER_DETAIL = (id: string) =>
  `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${id}/googleAds:searchStream`
const ANALYTICS_ADMIN_ACCOUNTS = 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries'

export const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/adwords',
  'https://www.googleapis.com/auth/analytics.readonly',
  'openid',
  'email',
  'profile',
]

export type GoogleTokenResponse = {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope: string
  token_type: 'Bearer'
  id_token?: string
}

export type GoogleAdsAccessibleCustomer = {
  resourceName: string            // e.g. "customers/1234567890"
  customerId: string              // bare digits
  descriptiveName?: string
  currencyCode?: string
  timeZone?: string
  manager?: boolean
}

export type GA4AccountSummary = {
  account: string                 // "accounts/12345"
  accountDisplay: string
  propertySummaries: Array<{
    property: string              // "properties/67890"
    propertyId: string            // bare digits
    displayName: string
  }>
}

function requireClientCreds(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET must be set to use the Google OAuth connector flow'
    )
  }
  return { clientId, clientSecret }
}

/**
 * Compute the OAuth redirect URI from the request host or `NEXT_PUBLIC_APP_URL`.
 * We accept a request so that preview deployments (vercel.app subdomains)
 * work without reconfiguring env vars — as long as the redirect is also
 * registered in the Google Cloud OAuth client.
 */
export function googleRedirectUri(request?: Request): string {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return `${process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/api/connectors/oauth/google/callback`
  }
  if (request) {
    const url = new URL(request.url)
    return `${url.origin}/api/connectors/oauth/google/callback`
  }
  throw new Error('Cannot derive Google OAuth redirect URI — set NEXT_PUBLIC_APP_URL')
}

/**
 * Build the URL we redirect the user to when they click "Connect with Google".
 * `access_type=offline` + `prompt=consent` is required to receive a
 * refresh_token on the first exchange (Google only returns one when the
 * user re-consents or it's the first grant).
 */
export function buildGoogleAuthUrl(params: {
  state: string
  redirectUri: string
  scopes?: string[]
}): string {
  const { clientId } = requireClientCreds()
  const qs = new URLSearchParams({
    client_id: clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: (params.scopes ?? GOOGLE_OAUTH_SCOPES).join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: params.state,
  })
  return `${GOOGLE_AUTH_BASE}?${qs.toString()}`
}

/**
 * Exchange an authorization code for access + refresh tokens.
 */
export async function exchangeGoogleAuthCode(params: {
  code: string
  redirectUri: string
}): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret } = requireClientCreds()
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: params.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Google token exchange failed (${res.status}): ${text.slice(0, 300)}`)
  }
  return (await res.json()) as GoogleTokenResponse
}

/**
 * Exchange a stored refresh token for a short-lived access token.
 * Callers should treat the returned token as single-use for one request
 * sequence; cache at most for the returned `expires_in` window.
 */
export async function refreshGoogleAccessToken(refreshToken: string): Promise<{
  accessToken: string
  expiresIn: number
}> {
  const { clientId, clientSecret } = requireClientCreds()
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Google refresh failed (${res.status}): ${text.slice(0, 300)}`)
  }
  const body = (await res.json()) as { access_token: string; expires_in: number }
  return { accessToken: body.access_token, expiresIn: body.expires_in }
}

/**
 * List Google Ads customer IDs the connecting user can access. Returns
 * bare customer IDs only — caller can fetch descriptive names in a
 * second pass if needed.
 */
export async function listAccessibleAdsCustomers(params: {
  accessToken: string
  developerToken: string
}): Promise<string[]> {
  const res = await fetch(GOOGLE_ADS_LIST_ACCESSIBLE, {
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      'developer-token': params.developerToken,
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Google Ads listAccessibleCustomers failed (${res.status}): ${text.slice(0, 300)}`)
  }
  const body = (await res.json()) as { resourceNames?: string[] }
  return (body.resourceNames || []).map((r) => r.replace(/^customers\//, ''))
}

/**
 * Enrich bare customer IDs with descriptive name, currency, and manager flag.
 * One searchStream call per customer — Google Ads API doesn't support
 * a bulk "describe these N customers" in a single call when the connecting
 * user might span multiple MCCs.
 */
export async function describeAdsCustomer(params: {
  accessToken: string
  developerToken: string
  customerId: string
  loginCustomerId?: string
}): Promise<GoogleAdsAccessibleCustomer | null> {
  const res = await fetch(GOOGLE_ADS_CUSTOMER_DETAIL(params.customerId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      'developer-token': params.developerToken,
      'content-type': 'application/json',
      ...(params.loginCustomerId ? { 'login-customer-id': params.loginCustomerId } : {}),
    },
    body: JSON.stringify({
      query: 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer LIMIT 1',
    }),
  })
  if (!res.ok) {
    // Customers we can enumerate but not query (e.g. test accounts with
    // no dev-token whitelist) shouldn't abort the whole flow. Return bare
    // shape so the picker still shows the ID.
    return { resourceName: `customers/${params.customerId}`, customerId: params.customerId }
  }
  // searchStream returns a stream of results; in practice for a single-row
  // query the response is a single JSON array.
  const body = (await res.json()) as Array<{ results?: Array<{ customer?: { id?: string; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean } }> }>
  const row = body[0]?.results?.[0]?.customer
  return {
    resourceName: `customers/${params.customerId}`,
    customerId: params.customerId,
    descriptiveName: row?.descriptiveName,
    currencyCode: row?.currencyCode,
    timeZone: row?.timeZone,
    manager: row?.manager ?? false,
  }
}

/**
 * List GA4 account summaries — each account contains its property summaries.
 * We flatten in the picker UI for a single selector.
 */
export async function listGA4AccountSummaries(accessToken: string): Promise<GA4AccountSummary[]> {
  const res = await fetch(`${ANALYTICS_ADMIN_ACCOUNTS}?pageSize=200`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GA4 accountSummaries failed (${res.status}): ${text.slice(0, 300)}`)
  }
  const body = (await res.json()) as {
    accountSummaries?: Array<{
      account: string
      displayName: string
      propertySummaries?: Array<{ property: string; displayName: string }>
    }>
  }
  return (body.accountSummaries || []).map((a) => ({
    account: a.account,
    accountDisplay: a.displayName,
    propertySummaries: (a.propertySummaries || []).map((p) => ({
      property: p.property,
      propertyId: p.property.replace(/^properties\//, ''),
      displayName: p.displayName,
    })),
  }))
}
