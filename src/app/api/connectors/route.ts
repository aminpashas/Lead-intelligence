import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import type { ConnectorType } from '@/lib/connectors'

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

  return NextResponse.json({
    connectors: connectorList.map((c) => ({
      ...c,
      stats: stats[c.connector_type] || { sent: 0, failed: 0 },
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

  const { data, error } = await supabase
    .from('connector_configs')
    .upsert({
      organization_id: profile.organization_id,
      connector_type: body.connector_type,
      enabled: body.enabled,
      credentials: body.credentials,
      settings: body.settings || {},
      updated_at: new Date().toISOString(),
    }, { onConflict: 'organization_id,connector_type' })
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
