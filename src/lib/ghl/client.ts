/**
 * GoHighLevel (LeadConnector) API client — read side.
 *
 * Auth is a static location-scoped Bearer token (Private Integration Token)
 * plus the `Version` header GHL requires on its v2 endpoints. Per-org config
 * lives in connector_configs (connector_type='ghl'):
 *   credentials.api_token    — the PIT (encrypted at rest)
 *   credentials.location_id  — GHL location/sub-account id
 *   credentials.pipeline_id  — optional; restrict sync to one pipeline
 *
 * (The generic Settings → Connectors form stores all fields under
 * `credentials`, so we read them from there, falling back to `settings` for the
 * non-secret identifiers.)
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { GhlConfig, GhlContact, GhlOpportunity, GhlPipeline } from './types'

export const GHL_BASE = 'https://services.leadconnectorhq.com'
export const GHL_VERSION = '2021-07-28'

/** Page size for opportunity search; GHL caps at 100. */
const SEARCH_PAGE_SIZE = 100

/**
 * SSRF guard. The base URL is fixed, but we still assert it here so a future
 * settings-driven override can never point the Bearer token at an attacker host.
 * Only https on leadconnectorhq.com (or a subdomain) is allowed.
 */
export function assertGhlHost(rawUrl: string): string {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    throw new Error('Invalid GHL URL')
  }
  const host = u.hostname.toLowerCase()
  if (u.protocol !== 'https:' || !(host === 'leadconnectorhq.com' || host.endsWith('.leadconnectorhq.com'))) {
    throw new Error(`Refusing non-GHL URL: ${rawUrl}`)
  }
  return rawUrl
}

/**
 * Resolve the GHL connection for an org. Returns null when not configured or
 * disabled (so callers treat it as a healthy no-op, not an error).
 */
export async function getGhlConfig(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<GhlConfig | null> {
  const { data } = await supabase
    .from('connector_configs')
    .select('credentials, settings, enabled')
    .eq('organization_id', organizationId)
    .eq('connector_type', 'ghl')
    .maybeSingle()

  if (!data || !data.enabled) return null

  const { decryptCredentials } = await import('@/lib/connectors/crypto')
  const creds = decryptCredentials(data.credentials as Record<string, unknown>) as Partial<{
    api_token: string
    location_id: string
    pipeline_id: string
  }>
  const settings = (data.settings || {}) as Partial<{
    location_id: string
    pipeline_id: string
    stage_authority: 'li' | 'ghl'
  }>

  const apiToken = (creds.api_token || '').trim()
  const locationId = (creds.location_id || settings.location_id || '').trim()
  const pipelineId = (creds.pipeline_id || settings.pipeline_id || '').trim() || null

  if (!apiToken || !locationId) return null

  return {
    apiToken,
    locationId,
    pipelineId,
    baseUrl: assertGhlHost(GHL_BASE),
    version: GHL_VERSION,
    // Default: LI owns the pipeline once a lead is imported (switch-to-LI).
    stageAuthority: settings.stage_authority === 'ghl' ? 'ghl' : 'li',
  }
}

function ghlHeaders(config: GhlConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiToken}`,
    Version: config.version,
    Accept: 'application/json',
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type GhlQuery = Record<string, string | number | boolean | undefined | null>

/**
 * Generic GHL GET. Encodes query params, enforces the host guard, and retries
 * once on 429 (rate limit) with a short backoff. Throws on any other non-2xx
 * with a truncated body for debuggability.
 */
export async function ghlFetch<T = unknown>(
  config: GhlConfig,
  path: string,
  query?: GhlQuery,
): Promise<T> {
  const url = new URL(`${config.baseUrl}${path.startsWith('/') ? path : '/' + path}`)
  assertGhlHost(url.toString())
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue
      url.searchParams.set(k, String(v))
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url.toString(), { headers: ghlHeaders(config) })
    if (res.status === 429 && attempt === 0) {
      await sleep(1200)
      continue
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`GHL ${res.status} ${path}: ${text.slice(0, 300)}`)
    }
    return (await res.json()) as T
  }
  // Unreachable in practice (the retry either returns or throws), but keeps TS happy.
  throw new Error(`GHL ${path}: exhausted retries`)
}

/**
 * POST to GHL. The write counterpart of `ghlFetch`.
 *
 * Deliberately does NOT retry on 429 the way the read path does: a send is not
 * idempotent, and a retried message is a message the patient receives twice.
 * The caller surfaces rate limits to the user instead.
 */
export async function ghlPost<T = unknown>(
  config: GhlConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const url = new URL(`${config.baseUrl}${path.startsWith('/') ? path : '/' + path}`)
  assertGhlHost(url.toString())

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { ...ghlHeaders(config), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GHL ${res.status} ${path}: ${text.slice(0, 300)}`)
  }
  return (await res.json()) as T
}

/** List the location's opportunity pipelines (with their stages). */
export async function fetchPipelines(config: GhlConfig): Promise<GhlPipeline[]> {
  const data = await ghlFetch<{ pipelines?: GhlPipeline[] }>(config, '/opportunities/pipelines', {
    locationId: config.locationId,
  })
  return data.pipelines ?? []
}

/** One page of opportunities plus the cursor for the next page. */
export type OpportunityPage = {
  opportunities: GhlOpportunity[]
  /** Cursor for the following page; undefined when this was the last page. */
  nextStartAfter?: string
  nextStartAfterId?: string
}

/**
 * One page of opportunities for a pipeline using GHL v2 cursor pagination.
 *
 * GHL deprecated `page`-based paging on /opportunities/search — it now returns
 * HTTP 400 ("Please use startAfter and startAfterId") unless you page with the
 * cursor echoed back in `meta`. Omit the cursor for the first page.
 */
export async function searchOpportunities(
  config: GhlConfig,
  params: { pipelineId: string; startAfter?: string; startAfterId?: string; limit?: number },
): Promise<OpportunityPage> {
  const data = await ghlFetch<{ opportunities?: GhlOpportunity[]; meta?: Record<string, unknown> }>(
    config,
    '/opportunities/search',
    {
      location_id: config.locationId,
      pipeline_id: params.pipelineId,
      limit: params.limit ?? SEARCH_PAGE_SIZE,
      startAfter: params.startAfter,
      startAfterId: params.startAfterId,
    },
  )
  const opportunities = data.opportunities ?? []
  const meta = data.meta ?? {}
  const last = opportunities.length >= (params.limit ?? SEARCH_PAGE_SIZE)
  return {
    opportunities,
    nextStartAfter: last && meta.startAfter != null ? String(meta.startAfter) : undefined,
    nextStartAfterId: last && meta.startAfterId != null ? String(meta.startAfterId) : undefined,
  }
}

/** Page size constant exposed so the sync loop can detect the last page. */
export { SEARCH_PAGE_SIZE }

/** Fetch a single contact by id. Returns null on any failure (best-effort). */
export async function getContact(config: GhlConfig, contactId: string): Promise<GhlContact | null> {
  try {
    const data = await ghlFetch<{ contact?: GhlContact }>(config, `/contacts/${contactId}`)
    return data.contact ?? null
  } catch {
    return null
  }
}

/**
 * True when an opportunity's inline contact lacks the email AND phone we need,
 * so we must fetch the full contact record. Pure predicate (unit-tested).
 */
export function contactNeedsFetch(opp: GhlOpportunity): boolean {
  const c = opp.contact
  if (c && (c.email || c.phone)) return false
  return Boolean(opp.contactId || c?.id)
}

/** Resolve the best contact for an opportunity: inline if sufficient, else fetch. */
export async function resolveOpportunityContact(
  config: GhlConfig,
  opp: GhlOpportunity,
): Promise<GhlContact | null> {
  if (!contactNeedsFetch(opp)) return opp.contact ?? null
  const contactId = opp.contactId || opp.contact?.id
  if (!contactId) return opp.contact ?? null
  const fetched = await getContact(config, contactId)
  return fetched ?? opp.contact ?? null
}
