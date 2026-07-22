/**
 * Coach a HUMAN staff call — AI feedback on what the staffer did well and where
 * to improve.
 *
 * POST /api/voice/calls/[id]/coach
 *   Body: { force?: boolean }
 *
 * WHY THIS EXISTS
 * ---------------
 * The "Analyze" button in Conversations grades the message thread. AI (Retell)
 * calls explode their transcript into per-turn `messages` rows, so the
 * conversation analyst can grade them line-by-line. HUMAN softphone/bridge calls
 * only drop a ONE-LINE marker in the thread ("Outbound call — completed · 3m
 * 05s", see staff-call-thread.ts) — the real transcript lives on
 * `voice_calls.transcript` and never reaches the analyst. So a manager could
 * never get "what did Heather do well / what to improve" on an actual human call.
 *
 * This route closes that gap: it turns the call's stored transcript into the
 * exact message shape the analyst expects and runs the SAME
 * `analyzeConversation` agent used by /api/ai/analyze — so coaching, scores and
 * HIPAA scrubbing are identical to the SMS path, no new prompt to drift.
 *
 * The result is persisted into `conversation_analyses` keyed on the call's voice
 * conversation (one row per conversation), and also returned for immediate
 * inline render on the call card. Not gated to admins: it only surfaces AI
 * feedback about a call the viewer can already see, and coaching is a
 * self-improvement tool office managers and reps both use.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { resolveActiveOrg, getOwnProfile } from '@/lib/auth/active-org'
import { analyzeConversation } from '@/lib/ai/conversation-analyst'
import { ensureVoiceConversation } from '@/lib/voice/staff-call-thread'
import { recordAudit } from '@/lib/audit/record'
import { logger } from '@/lib/logger'

// analyzeConversation is a heavyweight Sonnet generation — give it room.
export const maxDuration = 120

type TranscriptEntry = { role?: string; content?: string; timestamp_ms?: number }

/** The subset the call card renders — the fields shared by a fresh analysis and
 *  a persisted `conversation_analyses` row. */
const CACHED_COLUMNS =
  'coaching_notes, improvement_areas, things_done_well, empathy_level, ' +
  'rapport_building_score, active_listening_score, objection_handling_quality, ' +
  'sales_pressure_level, staff_tone, analyzed_at'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const authClient = await createClient()
    const {
      data: { user },
    } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await getOwnProfile(authClient, 'id, role, full_name')
    if (!profile) return NextResponse.json({ error: 'No profile' }, { status: 401 })

    const { orgId, role } = await resolveActiveOrg(authClient)
    if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 403 })

    const supabase = createServiceClient()
    const { data: call } = await supabase
      .from('voice_calls')
      .select('id, organization_id, lead_id, conversation_id, transcript, started_at, answered_at, ended_at')
      .eq('id', id)
      .maybeSingle()

    if (!call || (call.organization_id !== orgId && role !== 'agency_admin')) {
      return NextResponse.json({ error: 'Call not found' }, { status: 404 })
    }
    if (!call.ended_at) {
      return NextResponse.json({ error: 'Call is still in progress' }, { status: 422 })
    }

    // Turn the stored transcript into the message shape the analyst grades.
    // Staff speech = 'agent' role → outbound; the patient = 'lead' → inbound.
    const entries: TranscriptEntry[] = Array.isArray(call.transcript) ? call.transcript : []
    const turns = entries
      .map((t) => ({ role: t.role === 'lead' ? 'lead' : 'agent', content: String(t.content ?? '').trim(), ts: Number(t.timestamp_ms ?? 0) }))
      .filter((t) => t.content.length > 0)

    if (turns.length < 2) {
      return NextResponse.json(
        { error: 'This call has no usable transcript yet — nothing to coach.' },
        { status: 422 }
      )
    }

    // conversation_analyses.conversation_id is NOT NULL — attach coaching to the
    // call's voice conversation, creating one if this call never got a marker.
    const conversationId =
      call.conversation_id ?? (await ensureVoiceConversation(supabase, call.organization_id, call.lead_id))
    if (!conversationId) {
      return NextResponse.json({ error: 'Could not attach coaching to a conversation.' }, { status: 500 })
    }

    const body = await request.json().catch(() => ({}))
    const force = body?.force === true

    // Cheap path: reuse the last coaching pass unless the caller forces a re-run,
    // so re-opening the card doesn't burn a Sonnet call every time.
    if (!force) {
      const { data: existing } = await supabase
        .from('conversation_analyses')
        .select(CACHED_COLUMNS)
        .eq('conversation_id', conversationId)
        .maybeSingle()
      if (existing?.coaching_notes) {
        return NextResponse.json({ source: 'cached', analysis: existing })
      }
    }

    const { data: lead } = await supabase
      .from('leads')
      .select('*')
      .eq('id', call.lead_id)
      .maybeSingle()
    if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

    const baseMs = Date.parse(call.answered_at || call.started_at || call.ended_at || '') || Date.now()
    const messages = turns.map((t) => ({
      direction: t.role === 'lead' ? 'inbound' : 'outbound',
      body: t.content,
      sender_type: t.role === 'lead' ? 'lead' : 'user',
      created_at: new Date(baseMs + t.ts).toISOString(),
    }))

    const analysis = await analyzeConversation(supabase, {
      organization_id: call.organization_id,
      lead_id: call.lead_id,
      conversation_id: conversationId,
      lead,
      messages,
    })

    void recordAudit(supabase, {
      organizationId: call.organization_id,
      action: 'voice_call.coached',
      actor: { actorType: 'user', actorId: profile.id, actorLabel: profile.full_name ?? null },
      source: 'api_route',
      resourceType: 'voice_call',
      resourceId: call.id,
      ai: { autonomous: false, approved_by: profile.id, model: 'claude-sonnet-4-6' },
      metadata: { turns: turns.length, conversation_id: conversationId },
    })

    return NextResponse.json({ source: 'fresh', analysis })
  } catch (error) {
    logger.error('Call coaching failed', {
      call_id: id,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Coaching failed' },
      { status: 500 }
    )
  }
}
