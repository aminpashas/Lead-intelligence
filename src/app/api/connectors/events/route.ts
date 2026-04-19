import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'

// GET /api/connectors/events — List recent connector events for the org
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

  if (!['owner', 'admin', 'manager'].includes(profile.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const connectorType = searchParams.get('connector')
  const success = searchParams.get('success')
  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200)
  const offset = parseInt(searchParams.get('offset') || '0', 10)

  let query = supabase
    .from('connector_events')
    .select(`
      id, connector_type, event_type, success,
      status_code, error_message, response_id, dispatched_at,
      leads:lead_id ( id, first_name, last_name )
    `, { count: 'exact' })
    .eq('organization_id', profile.organization_id)
    .order('dispatched_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (connectorType) {
    query = query.eq('connector_type', connectorType)
  }
  if (success === 'true') {
    query = query.eq('success', true)
  } else if (success === 'false') {
    query = query.eq('success', false)
  }

  const { data: events, count, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Aggregate stats
  const stats = {
    total: count || 0,
    byConnector: {} as Record<string, { total: number; success: number; failed: number }>,
    byEvent: {} as Record<string, number>,
  }

  // Get 24h aggregate stats
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: recentEvents } = await supabase
    .from('connector_events')
    .select('connector_type, event_type, success')
    .eq('organization_id', profile.organization_id)
    .gte('dispatched_at', oneDayAgo)

  for (const event of recentEvents || []) {
    if (!stats.byConnector[event.connector_type]) {
      stats.byConnector[event.connector_type] = { total: 0, success: 0, failed: 0 }
    }
    stats.byConnector[event.connector_type].total++
    if (event.success) stats.byConnector[event.connector_type].success++
    else stats.byConnector[event.connector_type].failed++

    stats.byEvent[event.event_type] = (stats.byEvent[event.event_type] || 0) + 1
  }

  return NextResponse.json({
    events: events || [],
    stats,
    pagination: { limit, offset, total: count || 0 },
  })
}
