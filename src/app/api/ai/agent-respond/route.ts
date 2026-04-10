import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { routeToAgent, getHandoffHistory } from '@/lib/ai/agent-handoff'
import { getPatientProfile } from '@/lib/ai/patient-psychology'
import type { AgentContext, ConversationMessage } from '@/lib/ai/agent-types'
import type { Lead, Conversation, PatientProfile, ConversationChannel, LeadStatus } from '@/types/database'
import { storeTechniqueUsage, storeLeadAssessment, updateConversationSummary, getLatestAssessment, getRecentTechniqueHistory } from '@/lib/ai/technique-tracker'

const agentRespondSchema = z.object({
  conversation_id: z.string().uuid(),
})

// POST /api/ai/agent-respond — Unified agent endpoint
// Routes to Setter or Closer based on lead's pipeline stage
export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.ai)
  if (rlError) return rlError

  const supabase = await createClient()
  const body = await request.json()
  const parsed = agentRespondSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  // Auth check
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Fetch conversation with lead
  const { data: conversation } = await supabase
    .from('conversations')
    .select('*, lead:leads(*)')
    .eq('id', parsed.data.conversation_id)
    .single()

  if (!conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  const conv = conversation as Conversation & { lead: Lead }
  const lead = conv.lead

  if (!lead) {
    return NextResponse.json({ error: 'Lead not found for conversation' }, { status: 404 })
  }

  // Fetch patient profile
  const patientProfileRaw = await getPatientProfile(supabase, lead.id)
  const patientProfile = patientProfileRaw as PatientProfile | null

  // Fetch conversation history (last 20 messages)
  const { data: messages } = await supabase
    .from('messages')
    .select('direction, body, sender_type')
    .eq('conversation_id', parsed.data.conversation_id)
    .order('created_at', { ascending: true })
    .limit(20)

  const conversationHistory: ConversationMessage[] = (messages || []).map(
    (m: { direction: string; body: string }) => ({
      role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.body,
    })
  )

  // Fetch handoff history
  const handoffHistory = await getHandoffHistory(supabase, parsed.data.conversation_id)

  // Fetch previous assessment and technique history for feedback loop
  const [previousAssessment, techniqueHistory] = await Promise.all([
    getLatestAssessment(supabase, lead.id),
    getRecentTechniqueHistory(supabase, lead.id),
  ])

  // Build agent context
  const context: AgentContext = {
    lead,
    conversation_id: parsed.data.conversation_id,
    organization_id: profile.organization_id,
    channel: conv.channel as ConversationChannel,
    lead_status: lead.status as LeadStatus,
    patient_profile: patientProfile,
    conversation_history: conversationHistory,
    handoff_history: handoffHistory,
    message_count: conv.message_count || messages?.length || 0,
    previous_assessment: previousAssessment,
    technique_history: techniqueHistory,
  }

  try {
    const result = await routeToAgent(supabase, context)

    // Store technique tracking data (non-blocking)
    const messageIndex = conv.message_count || messages?.length || 0
    if (result.techniques_used && result.techniques_used.length > 0) {
      storeTechniqueUsage(supabase, {
        organization_id: profile.organization_id,
        conversation_id: parsed.data.conversation_id,
        lead_id: lead.id,
        message_index: messageIndex,
        agent_type: result.agent as 'setter' | 'closer',
        techniques: result.techniques_used,
      }).catch(() => {}) // Non-critical
    }

    if (result.lead_assessment) {
      storeLeadAssessment(supabase, {
        organization_id: profile.organization_id,
        conversation_id: parsed.data.conversation_id,
        lead_id: lead.id,
        message_index: messageIndex,
        assessment: result.lead_assessment,
      }).catch(() => {}) // Non-critical
    }

    // Update conversation summary (non-blocking)
    if (result.techniques_used && result.techniques_used.length > 0) {
      updateConversationSummary(
        supabase,
        parsed.data.conversation_id,
        profile.organization_id,
        lead.id
      ).catch(() => {}) // Non-critical
    }

    return NextResponse.json({
      message: result.message,
      confidence: result.confidence,
      agent: result.agent,
      action_taken: result.action_taken,
      should_handoff: result.should_handoff,
      internal_notes: result.internal_notes,
      techniques_used: result.techniques_used,
      lead_assessment: result.lead_assessment,
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Agent response failed'
    return NextResponse.json({ error: errorMsg }, { status: 500 })
  }
}
