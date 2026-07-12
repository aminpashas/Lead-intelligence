/**
 * Call Center stat-card drill-down.
 *
 * GET /api/voice/calls/list?metric=<today|connected|appointments|active>
 *
 * Returns the voice_calls behind a given stat card, newest first, with the
 * linked lead joined and decrypted so the client can render a smart-list of
 * calls that each link through to the lead. Uses the same applyCallMetric
 * filter as the card count, so the list length matches the badge.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { decryptLeadPII } from '@/lib/encryption'
import { applyCallMetric, isCallMetric, startOfTodayISO } from '@/lib/voice/call-metrics'

// Guard against a card ever expanding to an unbounded result set.
const MAX_ROWS = 200

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const metric = request.nextUrl.searchParams.get('metric')
  if (!isCallMetric(metric)) {
    return NextResponse.json({ error: 'Unknown metric' }, { status: 400 })
  }

  const query = applyCallMetric(
    supabase
      .from('voice_calls')
      .select(
        'id, direction, status, from_number, to_number, duration_seconds, outcome, agent_type, created_at, lead:leads(*)',
      )
      .eq('organization_id', orgId),
    metric,
    startOfTodayISO(),
  )
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS)

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Lead PII is encrypted at rest — decrypt before it leaves the server.
  const calls = (data || []).map((call) => ({
    ...call,
    lead: call.lead ? decryptLeadPII(call.lead as unknown as Record<string, unknown>) : null,
  }))

  return NextResponse.json({ calls })
}
