import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import type { ConnectorType } from '@/lib/connectors'
import { encryptCredentials } from '@/lib/connectors/crypto'

const VALID_CONNECTOR_TYPES: ConnectorType[] = [
  'google_ads', 'meta_capi', 'ga4', 'outbound_webhook', 'slack', 'google_reviews', 'callrail',
]

// GET /api/connectors — List all connector configs for the org
export async function GET(request: NextRequest) {
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

  // Only owners, admins, and managers can view connectors
  if (!['owner', 'admin', 'manager'].includes(profile.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data: configs, error } = await supabase
    .from('connector_configs')
    .select('id, connector_type, enabled, settings, created_at, updated_at')
    .eq('organization_id', profile.organization_id)
    .order('connector_type')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Build a complete list with all connector types (including unconfigured ones)
  const connectorList = VALID_CONNECTOR_TYPES.map((type) => {
    const existing = configs?.find((c) => c.connector_type === type)
    return {
      connector_type: type,
      configured: !!existing,
      enabled: existing?.enabled || false,
      settings: existing?.settings || {},
      id: existing?.id || null,
      created_at: existing?.created_at || null,
      updated_at: existing?.updated_at || null,
    }
  })

  // Get recent event counts per connector (last 24h)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: eventCounts } = await supabase
    .from('connector_events')
    .select('connector_type, success')
    .eq('organization_id', profile.organization_id)
    .gte('dispatched_at', oneDayAgo)

  const stats: Record<string, { sent: number; failed: number }> = {}
  for (const event of eventCounts || []) {
    if (!stats[event.connector_type]) {
      stats[event.connector_type] = { sent: 0, failed: 0 }
    }
    if (event.success) stats[event.connector_type].sent++
    else stats[event.connector_type].failed++
  }

  // Pull-side sync status for the channels that have an ad_metrics
  // pull module: google_ads, ga4, meta. Map by connector_type so the
  // UI can show "Synced 4h ago" badges next to push-side stats.
  const { data: syncStateRows } = await supabase
    .from('ad_metrics_sync_state')
    .select('channel, last_synced_at, last_success_at, last_error, rows_inserted_last_run')
    .eq('organization_id', profile.organization_id)

  // The ad_metrics_sync_state.channel = 'meta' but the connector_type
  // = 'meta_capi'. Normalize so the UI can look up by connector_type.
  const channelToConnectorType: Record<string, ConnectorType> = {
    google_ads: 'google_ads',
    ga4: 'ga4',
    meta: 'meta_capi',
  }
  const syncByConnector: Record<string, {
    last_synced_at: string | null
    last_success_at: string | null
    last_error: string | null
    rows_inserted_last_run: number | null
  }> = {}
  for (const row of (syncStateRows || []) as Array<{
    channel: string
    last_synced_at: string | null
    last_success_at: string | null
    last_error: string | null
    rows_inserted_last_run: number | null
  }>) {
    const ct = channelToConnectorType[row.channel]
    if (ct) {
      syncByConnector[ct] = {
        last_synced_at: row.last_synced_at,
        last_success_at: row.last_success_at,
        last_error: row.last_error,
        rows_inserted_last_run: row.rows_inserted_last_run,
      }
    }
  }

  return NextResponse.json({
    connectors: connectorList.map((c) => ({
      ...c,
      stats: stats[c.connector_type] || { sent: 0, failed: 0 },
      syncStatus: syncByConnector[c.connector_type] || null,
    })),
  })
}

// PUT /api/connectors — Create or update a connector config
export async function PUT(request: NextRequest) {
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

  // Only owners and admins can manage connectors
  if (!['owner', 'admin'].includes(profile.role)) {
    return NextResponse.json({ error: 'Forbidden — admin access required' }, { status: 403 })
  }

  const body = await request.json() as {
    connector_type: ConnectorType
    enabled: boolean
    credentials: Record<string, string>
    settings: Record<string, unknown>
  }

  if (!VALID_CONNECTOR_TYPES.includes(body.connector_type)) {
    return NextResponse.json({ error: 'Invalid connector type' }, { status: 400 })
  }

  // When the client sends an empty credentials object (e.g. toggling
  // enabled from the Settings UI), preserve what's already stored rather
  // than overwriting with {}. A genuine credential rotation will include
  // at least one populated field.
  const hasCredentialsPayload =
    body.credentials && Object.keys(body.credentials).some((k) => body.credentials[k] !== '' && body.credentials[k] != null)

  const upsertPayload: {
    organization_id: string
    connector_type: ConnectorType
    enabled: boolean
    settings: Record<string, unknown>
    updated_at: string
    credentials?: Record<string, unknown>
  } = {
    organization_id: profile.organization_id,
    connector_type: body.connector_type,
    enabled: body.enabled,
    settings: body.settings || {},
    updated_at: new Date().toISOString(),
  }

  if (hasCredentialsPayload) {
    // Encrypt each string value in credentials before persisting. The
    // underlying encryptField is idempotent (enc:: prefix check) so re-saves
    // of already-encrypted values remain safe.
    upsertPayload.credentials = encryptCredentials(body.credentials)
  }

  const { data, error } = await supabase
    .from('connector_configs')
    .upsert(upsertPayload, { onConflict: 'organization_id,connector_type' })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ connector: data })
}

// DELETE /api/connectors — Delete a connector config
export async function DELETE(request: NextRequest) {
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
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const connectorType = searchParams.get('type') as ConnectorType

  if (!connectorType || !VALID_CONNECTOR_TYPES.includes(connectorType)) {
    return NextResponse.json({ error: 'Invalid connector type' }, { status: 400 })
  }

  const { error } = await supabase
    .from('connector_configs')
    .delete()
    .eq('organization_id', profile.organization_id)
    .eq('connector_type', connectorType)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
