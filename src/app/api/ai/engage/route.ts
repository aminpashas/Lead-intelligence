import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateLeadEngagement } from '@/lib/ai/scoring'
import { z } from 'zod'

const engageSchema = z.object({
  lead_id: z.string().uuid(),
  conversation_id: z.string().uuid().optional(),
  mode: z.enum(['education', 'objection_handling', 'appointment_scheduling', 'follow_up']),
  channel: z.enum(['sms', 'email']),
})

// POST /api/ai/engage - Generate AI engagement message for a lead
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const body = await request.json()
  const parsed = engageSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get lead
  const { data: lead } = await supabase
    .from('leads')
    .select('*')
    .eq('id', parsed.data.lead_id)
    .single()

  if (!lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  // Get conversation history if conversation_id provided
  let history: Array<{ role: string; content: string }> = []
  if (parsed.data.conversation_id) {
    const { data: messages } = await supabase
      .from('messages')
      .select('direction, body')
      .eq('conversation_id', parsed.data.conversation_id)
      .order('created_at', { ascending: true })
      .limit(20)

    history = (messages || []).map((m: { direction: string; body: string }) => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.body,
    }))
  }

  try {
    const result = await generateLeadEngagement(lead, history, {
      mode: parsed.data.mode,
      channel: parsed.data.channel,
    })

    // Log AI interaction
    await supabase.from('ai_interactions').insert({
      organization_id: profile.organization_id,
      lead_id: lead.id,
      interaction_type: 'engagement',
      model: 'claude-sonnet-4-20250514',
      output_summary: result.message.substring(0, 200),
      success: true,
      metadata: { mode: parsed.data.mode, channel: parsed.data.channel },
    })

    return NextResponse.json({
      message: result.message,
      confidence: result.confidence,
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'AI engagement failed'
    return NextResponse.json({ error: errorMsg }, { status: 500 })
  }
}
