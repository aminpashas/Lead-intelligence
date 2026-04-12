import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { generateRolePlayResponse, generateRolePlayRetry } from '@/lib/ai/roleplay-engine'

const createSessionSchema = z.object({
  title: z.string().min(1).max(200),
  user_role: z.enum(['patient', 'treatment_coordinator']),
  agent_target: z.enum(['setter', 'closer']),
  scenario_id: z.string().nullable().optional(),
  scenario_description: z.string().nullable().optional(),
  patient_persona: z.object({
    name: z.string(),
    personality_type: z.string(),
    dental_condition: z.string(),
    emotional_state: z.string(),
    objections: z.array(z.string()),
    budget_concern: z.string(),
    custom_notes: z.string(),
  }).nullable().optional(),
})

const sendMessageSchema = z.object({
  session_id: z.string().uuid(),
  content: z.string().min(1),
})

const retrySchema = z.object({
  session_id: z.string().uuid(),
  retry: z.literal(true),
  message_index: z.number().int().min(0),
  feedback: z.string().nullable().optional(),
})

// GET — List role-play sessions
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: profile } = await supabase.from('user_profiles').select('organization_id').single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const status = url.searchParams.get('status')

  let query = supabase
    .from('ai_roleplay_sessions')
    .select('id, title, user_role, agent_target, scenario_description, status, overall_rating, extracted_example_count, created_at, updated_at')
    .eq('organization_id', profile.organization_id)
    .order('created_at', { ascending: false })
    .limit(50)

  if (status) {
    query = query.eq('status', status)
  }

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ sessions: data || [] })
}

// POST — Create session OR send message
export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.ai)
  if (rlError) return rlError

  const supabase = await createClient()
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()

  // Determine request type: create session, send message, or retry
  if (body.retry) {
    // ── Retry / Course Correct ──
    const parsed = retrySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
    }

    const { session_id, message_index, feedback } = parsed.data

    // Fetch the session
    const { data: session, error: sessionError } = await supabase
      .from('ai_roleplay_sessions')
      .select('*')
      .eq('id', session_id)
      .eq('organization_id', profile.organization_id)
      .single()

    if (sessionError || !session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    if (session.status !== 'active') {
      return NextResponse.json({ error: 'Session is not active' }, { status: 400 })
    }

    const messages = session.messages || []
    const targetMsg = messages[message_index]
    if (!targetMsg || targetMsg.role !== 'assistant') {
      return NextResponse.json({ error: 'Target message not found or not an AI message' }, { status: 400 })
    }

    const previousAttempt = targetMsg.content

    try {
      const aiResponseText = await generateRolePlayRetry(
        supabase,
        profile.organization_id,
        {
          user_role: session.user_role,
          agent_target: session.agent_target,
          patient_persona: session.patient_persona,
          scenario_description: session.scenario_description,
          messages: messages.slice(0, message_index), // only messages before the AI response
        },
        previousAttempt,
        feedback || null
      )

      // Update the message in place: store old content in previous_attempts, replace content
      const prevAttempts = targetMsg.previous_attempts || []
      prevAttempts.push(previousAttempt)

      const updatedMessages = [...messages]
      updatedMessages[message_index] = {
        ...targetMsg,
        content: aiResponseText,
        timestamp: new Date().toISOString(),
        previous_attempts: prevAttempts,
        retry_count: (targetMsg.retry_count || 0) + 1,
        is_finalized: false,
        rating: null, // reset rating on retry
      }

      // Save to DB
      await supabase
        .from('ai_roleplay_sessions')
        .update({ messages: updatedMessages })
        .eq('id', session_id)

      return NextResponse.json({
        updated_message: updatedMessages[message_index],
        message_index,
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to retry'
      console.error('Role-play retry error:', err)
      return NextResponse.json({ error: errorMsg }, { status: 500 })
    }
  } else if (body.session_id) {
    // ── Send Message ──
    const parsed = sendMessageSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
    }

    const { session_id, content } = parsed.data

    // Fetch the session
    const { data: session, error: sessionError } = await supabase
      .from('ai_roleplay_sessions')
      .select('*')
      .eq('id', session_id)
      .eq('organization_id', profile.organization_id)
      .single()

    if (sessionError || !session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    if (session.status !== 'active') {
      return NextResponse.json({ error: 'Session is not active' }, { status: 400 })
    }

    // Add user message
    const userActingAs = session.user_role
    const userMessage = {
      role: 'user' as const,
      content,
      timestamp: new Date().toISOString(),
      is_golden_example: false,
      rating: null,
      coaching_note: null,
      acting_as: userActingAs,
      is_finalized: false,
      retry_count: 0,
      previous_attempts: [] as string[],
    }

    const updatedMessages = [...(session.messages || []), userMessage]

    // Generate AI response
    try {
      const aiResponseText = await generateRolePlayResponse(
        supabase,
        profile.organization_id,
        {
          user_role: session.user_role,
          agent_target: session.agent_target,
          patient_persona: session.patient_persona,
          scenario_description: session.scenario_description,
          messages: updatedMessages,
        }
      )

      const aiActingAs = session.user_role === 'patient' ? 'treatment_coordinator' : 'patient'
      const aiMessage = {
        role: 'assistant' as const,
        content: aiResponseText,
        timestamp: new Date().toISOString(),
        is_golden_example: false,
        rating: null,
        coaching_note: null,
        acting_as: aiActingAs,
        is_finalized: false,
        retry_count: 0,
        previous_attempts: [] as string[],
      }

      const finalMessages = [...updatedMessages, aiMessage]

      // Update session
      await supabase
        .from('ai_roleplay_sessions')
        .update({ messages: finalMessages })
        .eq('id', session_id)

      return NextResponse.json({
        user_message: userMessage,
        ai_message: aiMessage,
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to generate response'
      console.error('Role-play response error:', err)
      return NextResponse.json({ error: errorMsg }, { status: 500 })
    }
  } else {
    // ── Create Session ──
    const parsed = createSessionSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('ai_roleplay_sessions')
      .insert({
        organization_id: profile.organization_id,
        created_by: profile.id,
        title: parsed.data.title,
        user_role: parsed.data.user_role,
        agent_target: parsed.data.agent_target,
        scenario_id: parsed.data.scenario_id || null,
        scenario_description: parsed.data.scenario_description || null,
        patient_persona: parsed.data.patient_persona || null,
        messages: [],
        status: 'active',
      })
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ session: data })
  }
}
