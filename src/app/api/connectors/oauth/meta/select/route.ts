/**
 * POST /api/connectors/oauth/meta/select
 *
 * Finalizes the Meta OAuth flow. Reads the picker state row, decrypts
 * the stashed long-lived access token, and upserts `connector_configs`
 * for `meta_capi` with the chosen Pixel + ad account bound.
 *
 * `testEventCode` is optional and explicitly meant for validating CAPI
 * events in Meta Events Manager's test mode before going live. We mirror
 * the manual-config form's semantics here.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { decryptCredentials, encryptCredentials } from '@/lib/connectors/crypto'

type SelectBody = {
  state: string
  pixelId: string
  adAccountId?: string            // "act_..." form, optional (informational)
  testEventCode?: string
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
  if (!body.state || !body.pixelId) {
    return NextResponse.json({ error: 'state and pixelId are required' }, { status: 400 })
  }

  const service = createServiceClient()
  const { data: stateRow, error: stateErr } = await service
    .from('oauth_states')
    .select('state, organization_id, provider, expires_at, metadata')
    .eq('state', body.state)
    .eq('provider', 'meta')
    .maybeSingle()

  if (stateErr || !stateRow) {
    return NextResponse.json({ error: 'invalid_or_consumed_state' }, { status: 400 })
  }
  if (stateRow.organization_id !== profile.organization_id) {
    return NextResponse.json({ error: 'state_org_mismatch' }, { status: 403 })
  }
  if (new Date(stateRow.expires_at).getTime() < Date.now()) {
    await service.from('oauth_states').delete().eq('state', body.state)
    return NextResponse.json({ error: 'state_expired' }, { status: 400 })
  }

  const metadata = (stateRow.metadata || {}) as {
    tokens?: { access_token?: string }
    token_expires_at?: string | null
  }
  const decryptedTokens = decryptCredentials(metadata.tokens || {}) as { access_token?: string }
  const accessToken = decryptedTokens.access_token
  if (!accessToken) {
    return NextResponse.json({ error: 'no_access_token_in_state' }, { status: 400 })
  }

  const credentials = encryptCredentials({
    pixelId: body.pixelId,
    accessToken,
    ...(body.adAccountId ? { adAccountId: body.adAccountId } : {}),
    ...(body.testEventCode ? { testEventCode: body.testEventCode } : {}),
  })

  const { error: upsertErr } = await service
    .from('connector_configs')
    .upsert(
      {
        organization_id: profile.organization_id,
        connector_type: 'meta_capi',
        enabled: true,
        credentials,
        settings: {
          // Public-ish identifiers for display + reconnect-nudge math.
          // The token itself is encrypted in credentials; this is just
          // the when-do-we-nag-them flag.
          ad_account_id: body.adAccountId,
          pixel_id: body.pixelId,
          token_expires_at: metadata.token_expires_at || null,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,connector_type' }
    )

  await service.from('oauth_states').delete().eq('state', body.state)

  if (upsertErr) {
    return NextResponse.json({ error: upsertErr.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    connected: ['meta_capi'],
    token_expires_at: metadata.token_expires_at || null,
  })
}
