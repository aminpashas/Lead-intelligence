import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { isAdminRole } from '@/lib/auth/permissions'

/**
 * GET /api/admin/enrichment-status — enrichment-provider diagnostics.
 *
 * Read-only, admin-gated. For each enrichment provider reports:
 *   - envConfigured: whether the provider's env credentials are present
 *   - smokeCheck: 'ok' | 'failed' | 'skipped' — a cheap live ping (credits /
 *     account / test-IP lookup) run ONLY when the env is configured. Wrapped in
 *     try/catch with a short timeout; a dead provider can never 500 this route.
 * Plus per-org `lead_enrichment` row counts grouped by enrichment_type and
 * status. An agency_admin sees every org's counts; practice admins see only
 * their own org's.
 */

const SMOKE_TIMEOUT_MS = 5_000

type SmokeCheck = 'ok' | 'failed' | 'skipped'

type ProviderStatus = {
  provider: string
  enrichmentType: string
  envConfigured: boolean
  smokeCheck: SmokeCheck
}

/** Cheap live ping with a hard timeout — resolves 'ok'/'failed', never throws. */
async function smoke(ping: () => Promise<Response>): Promise<SmokeCheck> {
  try {
    const res = await ping()
    return res.ok ? 'ok' : 'failed'
  } catch {
    return 'failed'
  }
}

async function checkZeroBounce(): Promise<ProviderStatus> {
  const base = { provider: 'zerobounce', enrichmentType: 'email_validation' }
  const apiKey = process.env.ZEROBOUNCE_API_KEY
  if (!apiKey) return { ...base, envConfigured: false, smokeCheck: 'skipped' }
  const smokeCheck = await smoke(() =>
    fetch(`https://api.zerobounce.net/v2/getcredits?api_key=${encodeURIComponent(apiKey)}`, {
      signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS),
    })
  )
  return { ...base, envConfigured: true, smokeCheck }
}

async function checkTwilioLookup(): Promise<ProviderStatus> {
  const base = { provider: 'twilio_lookup', enrichmentType: 'phone_validation' }
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) return { ...base, envConfigured: false, smokeCheck: 'skipped' }
  const smokeCheck = await smoke(() =>
    fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
      },
      signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS),
    })
  )
  return { ...base, envConfigured: true, smokeCheck }
}

async function checkMaxMind(): Promise<ProviderStatus> {
  const base = { provider: 'maxmind', enrichmentType: 'ip_geolocation' }
  const accountId = process.env.MAXMIND_ACCOUNT_ID
  const licenseKey = process.env.MAXMIND_LICENSE_KEY
  if (!accountId || !licenseKey) return { ...base, envConfigured: false, smokeCheck: 'skipped' }
  const smokeCheck = await smoke(() =>
    fetch('https://geolite.info/geoip/v2.1/city/8.8.8.8', {
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountId}:${licenseKey}`).toString('base64')}`,
      },
      signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS),
    })
  )
  return { ...base, envConfigured: true, smokeCheck }
}

function checkExperian(): ProviderStatus {
  // No live ping: the only cheap call is an OAuth password grant, and repeated
  // failed grants risk locking the Experian account. Env presence only.
  const envConfigured =
    !!process.env.EXPERIAN_CLIENT_ID &&
    !!process.env.EXPERIAN_CLIENT_SECRET &&
    !!process.env.EXPERIAN_USERNAME &&
    !!process.env.EXPERIAN_PASSWORD
  return { provider: 'experian', enrichmentType: 'credit_prequal', envConfigured, smokeCheck: 'skipped' }
}

function checkGoogleAdsKeyword(): ProviderStatus {
  // UTM-derived (no external API until the ClickView OAuth flow lands) — always
  // "configured", nothing to ping.
  return {
    provider: 'google_ads_keyword',
    enrichmentType: 'google_ads_keyword',
    envConfigured: true,
    smokeCheck: 'skipped',
  }
}

function checkWebsiteBehavior(): ProviderStatus {
  // Pure parsing of first-party tracking data — no external dependency.
  return {
    provider: 'website_behavior',
    enrichmentType: 'website_behavior',
    envConfigured: true,
    smokeCheck: 'skipped',
  }
}

export async function GET() {
  const supabase = await createClient()
  const { orgId, role } = await resolveActiveOrg(supabase)
  if (!orgId || !role) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isAdminRole(role)) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 })
  }

  const providers = await Promise.all([
    checkZeroBounce(),
    checkTwilioLookup(),
    checkMaxMind(),
    Promise.resolve(checkExperian()),
    Promise.resolve(checkGoogleAdsKeyword()),
    Promise.resolve(checkWebsiteBehavior()),
  ])

  // Per-org counts grouped by enrichment_type + status. Service client so an
  // agency_admin's cross-org view isn't silently truncated by RLS; every other
  // admin role is scoped to their own effective org.
  const service = createServiceClient()
  const scopeOrgId = role === 'agency_admin' ? null : orgId
  const { counts, countsError } = await fetchEnrichmentCounts(service, scopeOrgId)

  return NextResponse.json({ providers, counts, countsError })
}

type CountRow = {
  organization_id: string
  enrichment_type: string
  status: string
  count: number
}

// The check-constraint domain from migration 010 (010_lead_enrichment.sql).
// Used only by the fallback below — keep in sync if the migration grows.
const ENRICHMENT_TYPES = [
  'email_validation',
  'phone_validation',
  'ip_geolocation',
  'google_ads_keyword',
  'website_behavior',
  'credit_prequal',
] as const
const ENRICHMENT_STATUSES = ['pending', 'success', 'failed', 'skipped'] as const

/**
 * Single grouped query via PostgREST aggregates (`count()` — grouping is
 * implied by the selected columns). This project currently has aggregates
 * disabled ("Use of aggregate functions is not allowed"), so in practice the
 * fallback runs: one exact head-count per (org × enrichment_type × status)
 * combination — both enums are tiny (6 × 4) and head counts are cheap, so this
 * stays fast even with ~100k lead_enrichment rows. Zero-count combos are
 * omitted, matching what the grouped query would return.
 */
async function fetchEnrichmentCounts(
  service: ReturnType<typeof createServiceClient>,
  scopeOrgId: string | null
): Promise<{ counts: CountRow[]; countsError: string | null }> {
  let grouped = service
    .from('lead_enrichment')
    .select('organization_id, enrichment_type, status, count()')
  if (scopeOrgId) grouped = grouped.eq('organization_id', scopeOrgId)
  const { data, error } = await grouped
  if (!error) return { counts: (data ?? []) as CountRow[], countsError: null }

  // Which orgs to tally: the caller's effective org, or every org for the
  // agency-wide view.
  let orgIds: string[]
  if (scopeOrgId) {
    orgIds = [scopeOrgId]
  } else {
    const { data: orgs, error: orgsError } = await service.from('organizations').select('id')
    if (orgsError) return { counts: [], countsError: orgsError.message }
    orgIds = (orgs ?? []).map((o: { id: string }) => o.id)
  }

  const counts: CountRow[] = []
  for (const organizationId of orgIds) {
    // Skip orgs with no enrichment rows before fanning out 24 combo counts.
    const { count: orgTotal, error: totalError } = await service
      .from('lead_enrichment')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
    if (totalError) return { counts, countsError: totalError.message }
    if (!orgTotal) continue

    const combos = ENRICHMENT_TYPES.flatMap((t) => ENRICHMENT_STATUSES.map((s) => [t, s] as const))
    const comboCounts = await Promise.all(
      combos.map(async ([enrichmentType, status]) => {
        const { count } = await service
          .from('lead_enrichment')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .eq('enrichment_type', enrichmentType)
          .eq('status', status)
        return { organization_id: organizationId, enrichment_type: enrichmentType, status, count: count ?? 0 }
      })
    )
    counts.push(...comboCounts.filter((c) => c.count > 0))
  }
  return { counts, countsError: null }
}
