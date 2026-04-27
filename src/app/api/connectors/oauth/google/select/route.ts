/**
 * POST /api/connectors/oauth/google/select
 *
 * Finalizes the Google OAuth flow. The client sends the picker `state`
 * token plus the user's account choices; this route reads the pending
 * oauth_state row, decrypts the stashed tokens, writes the finalized
 * `connector_configs` rows (google_ads + ga4), and drops the state row.
 *
 * GA4's Measurement Protocol API Secret is not available via OAuth, so
 * it's accepted as a manual field on this submit (the UI labels where to
 * find it). If the user doesn't have it yet we still write the row as
 * `enabled: false` so they can return later to complete it.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { decryptCredentials, encryptCredentials } from '@/lib/connectors/crypto'

type SelectBody = {
  state: string
  ads?: {
    customerId: string
    loginCustomerId?: string
  } | null
  ga4?: {
    propertyId: string
    measurementId: string
    apiSecret?: string
    streamId?: string
  } | null
}

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .single()
  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!['owner', 'admin'].includes(profile.role)) {
    return NextResponse.json({ error: 'Forbidden — admin access required' }, { status: 403 })
  }

  const body = (await request.json()) as SelectBody
  if (!body.state) {
    return NextResponse.json({ error: 'state is required' }, { status: 400 })
  }
  if (!body.ads && !body.ga4) {
    return NextResponse.json({ error: 'Must select at least one of Google Ads or GA4' }, { status: 400 })
  }

  // Service client for both the state lookup (which may need to survive
  // an auth-context edge case) and for the connector_configs write.
  const service = createServiceClient()

  const { data: stateRow, error: stateErr } = await service
    .from('oauth_states')
    .select('state, organization_id, user_id, provider, expires_at, metadata')
    .eq('state', body.state)
    .eq('provider', 'google')
    .maybeSingle()

  if (stateErr || !stateRow) {
    return NextResponse.json({ error: 'invalid_or_consumed_state' }, { status: 400 })
  }
  if (stateRow.organization_id !== profile.organization_id) {
    // The state must belong to the caller's org — no cross-tenant finalization.
    return NextResponse.json({ error: 'state_org_mismatch' }, { status: 403 })
  }
  if (new Date(stateRow.expires_at).getTime() < Date.now()) {
    await service.from('oauth_states').delete().eq('state', body.state)
    return NextResponse.json({ error: 'state_expired' }, { status: 400 })
  }

  const metadata = (stateRow.metadata || {}) as {
    tokens?: { refresh_token?: string; access_token?: string }
  }
  const decryptedTokens = decryptCredentials(metadata.tokens || {}) as {
    refresh_token?: string
    access_token?: string
  }
  const refreshToken = decryptedTokens.refresh_token
  if (!refreshToken) {
    return NextResponse.json({ error: 'no_refresh_token_in_state' }, { status: 400 })
  }

  const writes: Array<Promise<{ type: string; error?: string }>> = []

  if (body.ads?.customerId) {
    const customerId = body.ads.customerId.replace(/\D/g, '')
    const loginCustomerId = body.ads.loginCustomerId?.replace(/\D/g, '') || undefined
    // We only persist the per-org fields here. clientId / clientSecret /
    // developerToken come from platform env vars at dispatch time — see
    // the dispatcher's getGoogleAdsConfigWithFallback helper.
    writes.push(
      service
        .from('connector_configs')
        .upsert(
          {
            organization_id: profile.organization_id,
            connector_type: 'google_ads',
            enabled: true,
            credentials: encryptCredentials({
              customerId,
              refreshToken,
              ...(loginCustomerId ? { loginCustomerId } : {}),
            }),
            settings: {},
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'organization_id,connector_type' }
        )
        .then(({ error }: { error: { message: string } | null }) => ({ type: 'google_ads', error: error?.message }))
    )
  }

  if (body.ga4?.propertyId) {
    const measurementId = body.ga4.measurementId?.trim()
    const apiSecret = body.ga4.apiSecret?.trim()
    // Without an API secret the connector row is written but stays
    // disabled — the user can come back and paste it in the existing
    // manual form on the connectors page.
    const ga4Enabled = Boolean(measurementId && apiSecret)
    writes.push(
      service
        .from('connector_configs')
        .upsert(
          {
            organization_id: profile.organization_id,
            connector_type: 'ga4',
            enabled: ga4Enabled,
            credentials: encryptCredentials({
              ...(measurementId ? { measurementId } : {}),
              ...(apiSecret ? { apiSecret } : {}),
              refreshToken,
              propertyId: body.ga4.propertyId,
              ...(body.ga4.streamId ? { streamId: body.ga4.streamId } : {}),
            }),
            settings: {
              // Keep the unencrypted property ID in settings for display —
              // it's a public identifier and used by the Data API path.
              property_id: body.ga4.propertyId,
              ...(body.ga4.streamId ? { stream_id: body.ga4.streamId } : {}),
            },
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'organization_id,connector_type' }
        )
        .then(({ error }: { error: { message: string } | null }) => ({ type: 'ga4', error: error?.message }))
    )
  }

  const results = await Promise.all(writes)
  const failures = results.filter((r) => r.error)

  // Drop the state row regardless of success — the tokens in it are now
  // either persisted into connector_configs or the user will need to retry.
  await service.from('oauth_states').delete().eq('state', body.state)

  if (failures.length > 0) {
    return NextResponse.json(
      {
        error: 'partial_write_failure',
        failures,
        wrote: results.filter((r) => !r.error).map((r) => r.type),
      },
      { status: 500 }
    )
  }

  return NextResponse.json({
    success: true,
    connected: results.map((r) => r.type),
  })
}
