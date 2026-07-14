import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { z } from 'zod'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { routeToAgent, getHandoffHistory } from '@/lib/ai/agent-handoff'
import { getPatientProfile } from '@/lib/ai/patient-psychology'
import type { AgentContext, ConversationMessage } from '@/lib/ai/agent-types'
import type { Lead, Conversation, PatientProfile, ConversationChannel, LeadStatus } from '@/types/database'
import { storeTechniqueUsage, storeLeadAssessment, updateConversationSummary, getLatestAssessment, getRecentTechniqueHistory } from '@/lib/ai/technique-tracker'
import { processEncounter } from '@/lib/ai/encounter-processor'
import { assessDraftGate } from '@/lib/ai/draft-gating'
import { escalateBlockedDraft } from '@/lib/ai/escalation-handoff'

const agentRespondSchema = z.object({
  conversation_id: z.string().uuid(),
})

// POST /api/ai/agent-respond — Unified agent endpoint
// Routes to Setter or Closer based on lead's pipeline stage
export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.ai)
  if (rlError) return rlError

  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json()
  const parsed = agentRespondSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  // Auth check
  const { data: profile } = await getOwnProfile(supabase, 'organization_id')

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
    organization_id: orgId,
    channel: conv.channel as ConversationChannel,
    lead_status: lead.status as LeadStatus,
    patient_profile: patientProfile,
    conversation_history: conversationHistory,
    handoff_history: handoffHistory,
    message_count: conv.message_count || messages?.length || 0,
    previous_assessment: previousAssessment,
    technique_history: techniqueHistory,
  }

  // ── Pre-generation gate ─────────────────────────────────────────
  // Before we spend a model call composing a closing message, decide whether a
  // sales draft is even appropriate. An enraged lead needs a human, not an
  // upbeat bot; a thread that already ended has nothing to reply to. This keeps
  // the composer honest with the Lead Intelligence panel that sits beside it.
  const gate = assessDraftGate({
    patientProfile,
    previousAssessment,
    history: conversationHistory,
    hasBookedAppointment: lead.status === 'consultation_scheduled',
  })

  if (gate.block) {
    // An escalation verdict must not just render in a banner and evaporate on
    // navigation — route it into the shared escalation spine so a human is
    // actually notified and the record persists. Best-effort and idempotent per
    // conversation; a service client is required for the notification writes.
    let escalated = false
    if (gate.kind === 'escalation') {
      try {
        const { escalationId } = await escalateBlockedDraft(createServiceClient(), {
          organizationId: orgId,
          conversationId: parsed.data.conversation_id,
          leadId: lead.id,
          reason: gate.reason,
          guidance: gate.guidance,
        })
        escalated = !!escalationId
      } catch (err) {
        console.warn('[agent-respond] Escalation handoff failed:', err instanceof Error ? err.message : err)
      }
    }

    return NextResponse.json({
      blocked: true,
      block_kind: gate.kind,
      reason: gate.reason,
      guidance: gate.guidance,
      message: null,
      escalated,
    })
  }

  try {
    const result = await routeToAgent(supabase, context)

    // Store technique tracking data (non-blocking)
    const messageIndex = conv.message_count || messages?.length || 0
    if (result.techniques_used && result.techniques_used.length > 0) {
      storeTechniqueUsage(supabase, {
        organization_id: orgId,
        conversation_id: parsed.data.conversation_id,
        lead_id: lead.id,
        message_index: messageIndex,
        agent_type: result.agent as 'setter' | 'closer',
        techniques: result.techniques_used,
      }).catch((err: unknown) => console.warn('[agent-respond] Technique tracking failed:', err instanceof Error ? err.message : err)) // Non-critical
    }

    if (result.lead_assessment) {
      storeLeadAssessment(supabase, {
        organization_id: orgId,
        conversation_id: parsed.data.conversation_id,
        lead_id: lead.id,
        message_index: messageIndex,
        assessment: result.lead_assessment,
      }).catch((err: unknown) => console.warn('[agent-respond] Lead assessment storage failed:', err instanceof Error ? err.message : err)) // Non-critical
    }

    // Update conversation summary (non-blocking)
    if (result.techniques_used && result.techniques_used.length > 0) {
      updateConversationSummary(
        supabase,
        parsed.data.conversation_id,
        orgId,
        lead.id
      ).catch((err: unknown) => console.warn('[agent-respond] Conversation summary update failed:', err instanceof Error ? err.message : err)) // Non-critical
    }

    // ── Unified Post-Encounter Processing (same pipeline as Voice) ──
    // Build transcript from conversation history + new AI response
    const fullTranscript = [
      ...conversationHistory.map(m => 
        m.role === 'user' ? `User: ${m.content}` : `Agent: ${m.content}`
      ),
      `Agent: ${result.message}`,
    ].join('\n')

    processEncounter({
      channel: conv.channel as 'sms' | 'email' | 'voice',
      orgId: orgId,
      leadId: lead.id,
      conversationId: parsed.data.conversation_id,
      transcript: fullTranscript,
      summary: result.internal_notes || null,
      sentiment: (result.lead_assessment?.engagement_temperature ?? 0) >= 7 ? 'Positive'
        : (result.lead_assessment?.engagement_temperature ?? 0) >= 4 ? 'Neutral'
        : (result.lead_assessment?.engagement_temperature ?? 0) >= 1 ? 'Negative'
        : null,
      callSuccessful: result.confidence > 0.7,
    }).catch((err: unknown) => console.warn('[agent-respond] Encounter processing failed (non-blocking):', err instanceof Error ? err.message : err))

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
