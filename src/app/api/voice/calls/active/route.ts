/**
 * Active Voice Call + Live Transcript API
 *
 * GET /api/voice/calls/active?lead_id=<uuid>
 *
 * Powers the in-thread "ongoing call" indicator and live transcript. This is a
 * single endpoint that answers two questions in one round-trip so the client can
 * poll one URL:
 *   1. Is there a call currently in progress for this lead? (cheap DB lookup)
 *   2. If so, what has been said so far? (interim transcript from Retell)
 *
 * We deliberately poll instead of using Supabase Realtime: `voice_calls` is not
 * in the `supabase_realtime` publication, and on serverless there is no
 * long-lived process to stream from. The client polls slowly when idle and fast
 * while a call is live (see use-live-call.ts).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { getCallDetail } from '@/lib/voice/retell-client'
import { logger } from '@/lib/logger'
import { ACTIVE_CALL_STATUSES, activeCallFreshnessCutoffISO } from '@/lib/voice/call-metrics'

type LiveEntry = { role: 'agent' | 'lead'; content: string }

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const leadId = request.nextUrl.searchParams.get('lead_id')
  if (!leadId) {
    return NextResponse.json({ error: 'lead_id is required' }, { status: 400 })
  }

  // Most-recent still-open call for this lead, scoped to the active org (RLS +
  // explicit filter as defense-in-depth).
  const { data: call } = await supabase
    .from('voice_calls')
    .select('id, direction, agent_type, status, retell_call_id, started_at, ended_at')
    .eq('lead_id', leadId)
    .eq('organization_id', orgId)
    .is('ended_at', null)
    .in('status', ACTIVE_CALL_STATUSES)
    // A row stranded past the freshness window is a missed-webhook phantom, not a
    // live call — don't light up the thread's "ongoing call" indicator for it.
    .gte('created_at', activeCallFreshnessCutoffISO())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!call) {
    return NextResponse.json({ active: false })
  }

  const base = {
    active: true,
    call: {
      id: call.id,
      direction: call.direction,
      agent_type: call.agent_type,
      started_at: call.started_at,
    },
  }

  // Call row exists but Retell hasn't been dialed yet — we're still connecting.
  if (!call.retell_call_id) {
    return NextResponse.json({ ...base, status: 'connecting', entries: [] as LiveEntry[] })
  }

  try {
    const detail = await getCallDetail(call.retell_call_id)

    // Retell role 'user' is the patient/lead on the phone; 'agent' is our AI.
    const entries: LiveEntry[] = (detail.transcript_object || [])
      .filter((t) => t && typeof t.content === 'string' && t.content.trim().length > 0)
      .map((t) => ({ role: t.role === 'agent' ? 'agent' : 'lead', content: t.content }))

    const status =
      detail.call_status === 'ongoing' ? 'live'
      : detail.call_status === 'ended' || detail.call_status === 'error' ? 'ended'
      : 'connecting' // 'registered' — ringing / not yet answered

    return NextResponse.json({ ...base, status, entries })
  } catch (error) {
    // A transient Retell error must not blank out the UI mid-call: keep the
    // indicator up and let the next poll retry.
    logger.error(
      'Live call transcript fetch failed',
      { callId: call.id },
      error instanceof Error ? error : undefined
    )
    return NextResponse.json({ ...base, status: 'live', entries: [] as LiveEntry[] })
  }
}
