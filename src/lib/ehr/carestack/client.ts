/**
 * CareStack API client.
 *
 * Auth: OAuth2 password grant against the CareStack Identity Provider. Bearer tokens
 * have a 1-hour TTL; we cache per-account in-memory so a single dyno doesn't
 * re-issue on every call. Cold starts re-issue (acceptable: token request is fast).
 *
 * Per-org credentials live in connector_configs (connector_type='carestack'):
 *   credentials.account_id      — CareStack-AccountId (used for webhook signature too)
 *   credentials.client_id       — vendor's developer client_id
 *   credentials.client_secret   — vendor's developer secret
 *   credentials.username        — vendor key (same across all accounts for this vendor)
 *   credentials.password        — account key (per-CareStack-account)
 *   credentials.webhook_secret  — base64 secret for HMAC verification (CareStack provides on registration)
 *   settings.base_url           — e.g. https://api.carestack.com
 *   settings.identity_url       — e.g. https://id.carestack.com
 *
 * Brief reference: PDF §"Authentication" (page ~5).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type CareStackConfig = {
  account_id: string
  client_id: string
  client_secret: string
  username: string                  // vendor key
  password: string                  // account key
  webhook_secret?: string           // for HMAC-SHA256 webhook validation
  base_url: string                  // e.g. https://api.carestack.com
  identity_url: string              // e.g. https://id.carestack.com
}

type TokenCacheEntry = {
  accessToken: string
  expiresAt: number                 // ms epoch
}

// In-memory token cache, keyed by `${identity_url}::${account_id}::${client_id}`.
// Cleared on cold start; that's fine — 1h TTL means most warm requests reuse.
const tokenCache = new Map<string, TokenCacheEntry>()

const TOKEN_BUFFER_MS = 60_000        // refresh 60s before expiry to avoid edge-of-window 401s

/**
 * Load CareStack config for an organization. Returns null if not configured / disabled.
 */
export async function getCareStackConfig(
  supabase: SupabaseClient,
  organizationId: string
): Promise<CareStackConfig | null> {
  const { data } = await supabase
    .from('connector_configs')
    .select('credentials, settings, enabled')
    .eq('organization_id', organizationId)
    .eq('connector_type', 'carestack')
    .single()

  if (!data || !data.enabled) return null

  const creds = (data.credentials || {}) as Partial<CareStackConfig>
  const settings = (data.settings || {}) as Partial<{ base_url: string; identity_url: string }>

  if (!creds.account_id || !creds.client_id || !creds.client_secret || !creds.username || !creds.password) {
    return null
  }

  return {
    account_id: creds.account_id,
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    username: creds.username,
    password: creds.password,
    webhook_secret: creds.webhook_secret,
    base_url: (settings.base_url || 'https://api.carestack.com').replace(/\/$/, ''),
    identity_url: (settings.identity_url || 'https://id.carestack.com').replace(/\/$/, ''),
  }
}

/**
 * Get a valid Bearer token for the configured account, refreshing if expired.
 */
export async function getAccessToken(config: CareStackConfig): Promise<string> {
  const cacheKey = `${config.identity_url}::${config.account_id}::${config.client_id}`
  const now = Date.now()
  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expiresAt - TOKEN_BUFFER_MS > now) {
    return cached.accessToken
  }

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: config.client_id,
    client_secret: config.client_secret,
    username: config.username,
    password: config.password,
  })

  const res = await fetch(`${config.identity_url}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`CareStack token request failed: ${res.status} ${text.slice(0, 200)}`)
  }

  const data = await res.json() as { access_token: string; expires_in: number; token_type?: string }
  const expiresAt = now + (data.expires_in || 3600) * 1000

  tokenCache.set(cacheKey, { accessToken: data.access_token, expiresAt })
  return data.access_token
}

export type CareStackFetchOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  body?: unknown
  query?: Record<string, string | number | boolean | undefined | null>
  /** API version path segment (default 'v1.0') */
  version?: string
  /** Override path prefix (default '/api'). e.g. '/scheduler/api' for appointment search. */
  pathPrefix?: string
  /** If true, return raw Response instead of parsing JSON. */
  raw?: boolean
}

/**
 * Generic CareStack API request. Auto-handles auth, version path, query encoding.
 * Throws on non-2xx with the response body included in the error message.
 */
export async function carestackFetch<T = unknown>(
  config: CareStackConfig,
  path: string,
  opts: CareStackFetchOptions = {}
): Promise<T> {
  const token = await getAccessToken(config)
  const version = opts.version || 'v1.0'
  const prefix = opts.pathPrefix || '/api'

  const url = new URL(`${config.base_url}${prefix}/${version}${path.startsWith('/') ? path : '/' + path}`)
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined || v === null) continue
      url.searchParams.set(k, String(v))
    }
  }

  const init: RequestInit = {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }

  const res = await fetch(url.toString(), init)

  if (res.status === 401) {
    // Token may have been revoked server-side mid-cache; clear and retry once.
    tokenCache.delete(`${config.identity_url}::${config.account_id}::${config.client_id}`)
    const retryToken = await getAccessToken(config)
    const retry = await fetch(url.toString(), {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${retryToken}` },
    })
    if (!retry.ok) {
      const text = await retry.text().catch(() => '')
      throw new Error(`CareStack ${res.status} after retry: ${text.slice(0, 300)}`)
    }
    return opts.raw ? (retry as unknown as T) : (await retry.json() as T)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`CareStack ${res.status} ${path}: ${text.slice(0, 300)}`)
  }

  return opts.raw ? (res as unknown as T) : (await res.json() as T)
}
