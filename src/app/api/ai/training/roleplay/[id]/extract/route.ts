import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { extractTrainingExamples, generateSessionSummary } from '@/lib/ai/roleplay-engine'
import type { AIRolePlaySession } from '@/types/database'

type RouteParams = { params: Promise<{ id: string }> }

// POST — Extract training examples from a completed session
export async function POST(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const supabase = await createClient()
  const { data: profile } = await supabase.from('user_profiles').select('organization_id').single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Fetch session
  const { data: session, error: sessionError } = await supabase
    .from('ai_roleplay_sessions')
    .select('*')
    .eq('id', id)
    .eq('organization_id', profile.organization_id)
    .single()

  if (sessionError || !session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  const typedSession = session as AIRolePlaySession

  try {
    // Extract training examples and generate summary in parallel
    const [examples, summary] = await Promise.all([
      extractTrainingExamples(typedSession),
      generateSessionSummary(typedSession),
    ])

    // Save training examples to DB
    if (examples.length > 0) {
      const { error: insertError } = await supabase
        .from('ai_training_examples')
        .insert(
          examples.map((ex) => ({
            organization_id: profile.organization_id,
            session_id: id,
            category: ex.category,
            scenario_context: ex.scenario_context,
            patient_message: ex.patient_message,
            ideal_response: ex.ideal_response,
            coaching_notes: ex.coaching_notes,
            agent_target: typedSession.agent_target,
            is_approved: false,
            is_active: false,
          }))
        )

      if (insertError) {
        console.error('Failed to save training examples:', insertError)
      }
    }

    // Update session with summary and example count
    await supabase
      .from('ai_roleplay_sessions')
      .update({
        session_summary: summary,
        extracted_example_count: examples.length,
        status: 'completed',
      })
      .eq('id', id)

    return NextResponse.json({
      summary,
      examples,
      example_count: examples.length,
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Extraction failed'
    console.error('Training extraction error:', err)
    return NextResponse.json({ error: errorMsg }, { status: 500 })
  }
}
