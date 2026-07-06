import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { analyzeConversation } from '@/lib/ai/conversation-analyst'
import { analyzePatientPsychology, getPatientProfile } from '@/lib/ai/patient-psychology'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'

// Both agents are heavyweight Sonnet generations; give the function room to finish.
export const maxDuration = 120

/**
 * POST /api/ai/analyze
 *
 * Triggers both AI agents on a conversation and STREAMS each result as it
 * finishes (newline-delimited JSON), so the UI can fill in progressively
 * instead of blocking on the slower agent:
 * 1. Conversation Analyst — rates tone, engagement, sales quality
 * 2. Patient Psychology — updates the patient's psychological profile
 *
 * Body: { conversation_id: string, lead_id: string }
 *
 * Stream chunks (one JSON object per line):
 *   { "type": "conversation_analysis", "data": {...} }
 *   { "type": "patient_profile", "data": {...} }
 *   { "type": "error", "agent": "conversation"|"psychology", "message": "..." }
 *   { "type": "done" }
 */
export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.ai)
  if (rlError) return rlError

  try {
    const supabase = await createClient()
    const { orgId } = await resolveActiveOrg(supabase)
    if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('organization_id')
      .eq('id', user.id)
      .single()
    if (!profile) return NextResponse.json({ error: 'No profile' }, { status: 401 })

    const body = await request.json()
    const { conversation_id, lead_id } = body

    if (!conversation_id || !lead_id) {
      return NextResponse.json({ error: 'conversation_id and lead_id required' }, { status: 400 })
    }

    // Fetch lead
    const { data: lead } = await supabase
      .from('leads')
      .select('*')
      .eq('id', lead_id)
      .eq('organization_id', orgId)
      .single()

    if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

    // Fetch conversation messages
    const { data: messages } = await supabase
      .from('messages')
      .select('direction, body, sender_type, created_at')
      .eq('conversation_id', conversation_id)
      .eq('organization_id', orgId)
      .order('created_at', { ascending: true })

    if (!messages || messages.length < 2) {
      return NextResponse.json({ error: 'Need at least 2 messages to analyze' }, { status: 400 })
    }

    const existingProfile = await getPatientProfile(supabase, lead_id)

    // Stream each agent's result the moment it settles. The two agents run
    // concurrently, so the fast one reaches the client without waiting on the
    // slow one — the UI panel fills in progressively.
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) =>
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))

        const conversationTask = analyzeConversation(supabase, {
          organization_id: orgId,
          lead_id,
          conversation_id,
          lead,
          messages,
        })
          .then((data) => send({ type: 'conversation_analysis', data }))
          .catch((e) =>
            send({
              type: 'error',
              agent: 'conversation',
              message: e instanceof Error ? e.message : 'Conversation analysis failed',
            })
          )

        const psychologyTask = analyzePatientPsychology(supabase, {
          organization_id: orgId,
          lead_id,
          conversation_id,
          lead,
          messages,
          existingProfile,
        })
          .then((data) => send({ type: 'patient_profile', data }))
          .catch((e) =>
            send({
              type: 'error',
              agent: 'psychology',
              message: e instanceof Error ? e.message : 'Psychology analysis failed',
            })
          )

        await Promise.allSettled([conversationTask, psychologyTask])
        send({ type: 'done' })
        controller.close()
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
      },
    })
  } catch (error) {
    console.error('AI analyze error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Analysis failed' },
      { status: 500 }
    )
  }
}
