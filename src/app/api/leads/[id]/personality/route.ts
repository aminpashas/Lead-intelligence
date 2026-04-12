import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { ANALYSIS_PROMPTS } from '@/lib/ai/personality-types'
import type { PersonalityProfile } from '@/lib/ai/personality-types'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const { id: leadId } = await params
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get lead
  const { data: lead } = await supabase
    .from('leads')
    .select('id, first_name, last_name, organization_id')
    .eq('id', leadId)
    .eq('organization_id', profile.organization_id)
    .single()

  if (!lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  // Fetch all messages from this lead's conversations (inbound from them)
  const { data: messages } = await supabase
    .from('messages')
    .select('body, direction, channel, created_at, sender_type')
    .eq('lead_id', leadId)
    .eq('organization_id', profile.organization_id)
    .order('created_at', { ascending: true })
    .limit(200)

  if (!messages || messages.length < 3) {
    return NextResponse.json({
      error: 'Not enough conversation data',
      detail: `Need at least 3 messages, found ${messages?.length || 0}`,
    }, { status: 400 })
  }

  // Format messages for analysis
  const conversationText = messages
    .map((m) => {
      const role = m.direction === 'inbound' ? `LEAD (${lead.first_name})` : 'AI/TEAM'
      return `[${role}]: ${m.body}`
    })
    .join('\n')

  // Calculate response time stats
  const inboundTimes: number[] = []
  let lastOutbound: Date | null = null

  for (const m of messages) {
    if (m.direction === 'outbound') {
      lastOutbound = new Date(m.created_at)
    } else if (m.direction === 'inbound' && lastOutbound) {
      const diff = (new Date(m.created_at).getTime() - lastOutbound.getTime()) / 60000
      if (diff > 0 && diff < 10080) { // Within 7 days
        inboundTimes.push(diff)
      }
      lastOutbound = null
    }
  }

  const avgResponseMinutes = inboundTimes.length > 0
    ? Math.round(inboundTimes.reduce((a, b) => a + b, 0) / inboundTimes.length)
    : null

  // Call OpenAI for personality analysis
  const openaiKey = process.env.OPENAI_API_KEY

  if (!openaiKey) {
    return NextResponse.json({ error: 'OpenAI not configured' }, { status: 500 })
  }

  try {
    const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: ANALYSIS_PROMPTS.system },
          {
            role: 'user',
            content: `Analyze this lead's personality from their conversation history (${messages.length} messages total, ${messages.filter(m => m.direction === 'inbound').length} from the lead):\n\n${conversationText}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 1000,
        response_format: { type: 'json_object' },
      }),
    })

    if (!aiResponse.ok) {
      const errText = await aiResponse.text()
      return NextResponse.json({ error: 'AI analysis failed', detail: errText }, { status: 500 })
    }

    const aiData = await aiResponse.json()
    const analysisRaw = JSON.parse(aiData.choices[0].message.content)

    // Build the full personality profile
    const personalityProfile: PersonalityProfile = {
      primary_type: analysisRaw.primary_type || 'amiable',
      secondary_type: analysisRaw.secondary_type || null,
      confidence: analysisRaw.confidence || 70,
      communication_tempo: analysisRaw.communication_tempo || 'moderate',
      avg_response_time_minutes: avgResponseMinutes,
      message_length: analysisRaw.message_length || 'moderate',
      avg_message_words: analysisRaw.avg_message_words || null,
      traits: {
        decisiveness: analysisRaw.traits?.decisiveness ?? 50,
        price_sensitivity: analysisRaw.traits?.price_sensitivity ?? 50,
        trust_level: analysisRaw.traits?.trust_level ?? 50,
        emotional_expressiveness: analysisRaw.traits?.emotional_expressiveness ?? 50,
        detail_orientation: analysisRaw.traits?.detail_orientation ?? 50,
        urgency: analysisRaw.traits?.urgency ?? 50,
        research_tendency: analysisRaw.traits?.research_tendency ?? 50,
        social_proof_need: analysisRaw.traits?.social_proof_need ?? 50,
      },
      emotional_state: analysisRaw.emotional_state || 'neutral',
      decision_style: analysisRaw.decision_style || 'deliberate',
      preferred_channel: null, // Will be computed
      best_contact_time: null,
      objections_raised: analysisRaw.objections_raised || [],
      interests_expressed: analysisRaw.interests_expressed || [],
      buying_signals: analysisRaw.buying_signals || [],
      recommended_approach: analysisRaw.recommended_approach || '',
      communication_tips: analysisRaw.communication_tips || [],
      messages_analyzed: messages.length,
      last_analyzed_at: new Date().toISOString(),
    }

    // Determine preferred channel from message history
    const channelCounts = { sms: 0, email: 0, phone: 0 }
    for (const m of messages.filter((m) => m.direction === 'inbound')) {
      if (m.channel === 'sms') channelCounts.sms++
      else if (m.channel === 'email') channelCounts.email++
      else if (m.channel === 'voice') channelCounts.phone++
    }
    const topChannel = Object.entries(channelCounts).sort((a, b) => b[1] - a[1])[0]
    if (topChannel && topChannel[1] > 0) {
      personalityProfile.preferred_channel = topChannel[0] as 'sms' | 'email' | 'phone'
    }

    // Save to lead
    const { error: updateError } = await supabase
      .from('leads')
      .update({ personality_profile: personalityProfile as unknown as Record<string, unknown> })
      .eq('id', leadId)
      .eq('organization_id', profile.organization_id)

    if (updateError) {
      return NextResponse.json({ error: 'Failed to save profile', detail: updateError.message }, { status: 500 })
    }

    // Log activity
    await supabase.from('lead_activities').insert({
      organization_id: profile.organization_id,
      lead_id: leadId,
      user_id: profile.id,
      activity_type: 'personality_analyzed',
      title: `Personality analyzed: ${personalityProfile.primary_type}`,
      description: personalityProfile.recommended_approach,
    })

    return NextResponse.json({ personality_profile: personalityProfile })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// GET — retrieve existing personality profile
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: leadId } = await params
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: lead } = await supabase
    .from('leads')
    .select('personality_profile')
    .eq('id', leadId)
    .eq('organization_id', profile.organization_id)
    .single()

  if (!lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  return NextResponse.json({ personality_profile: lead.personality_profile })
}
