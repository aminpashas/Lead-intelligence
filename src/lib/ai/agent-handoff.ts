/**
 * Agent Handoff Manager
 *
 * Orchestrates routing between Setter and Closer agents.
 * Manages context transfer during handoffs and maintains audit trail.
 *
 * Key design: Routing is DETERMINISTIC based on pipeline stage (STAGE_AGENT_MAP).
 * The AI can suggest handoffs, but the handoff manager validates them.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { LeadStatus, PatientProfile } from '@/types/database'
import type {
  AgentType,
  AgentContext,
  AgentResponse,
  HandoffContextSnapshot,
  HandoffRecord,
} from './agent-types'
import { STAGE_AGENT_MAP } from './agent-types'
import { setterAgentRespond } from './setter-agent'
import { closerAgentRespond } from './closer-agent'
import { generateLeadEngagement } from './scoring'
import { logHIPAAEvent } from './hipaa'

// ═══════���════════════════════════════��═══════════════════════════
// DETERMINE ACTIVE AGENT
// ════════════════��═══════════════════════════════════���═══════════

/**
 * Determines which agent should handle this conversation based on
 * the lead's current pipeline stage.
 *
 * Returns the correct agent from STAGE_AGENT_MAP and whether a
 * handoff is needed (current != correct).
 */
export function determineActiveAgent(
  currentAgent: AgentType,
  leadStatus: LeadStatus
): { agent: AgentType; needsHandoff: boolean; reason: string | null } {
  const correctAgent = STAGE_AGENT_MAP[leadStatus] || 'none'

  if (currentAgent === correctAgent) {
    return { agent: currentAgent, needsHandoff: false, reason: null }
  }

  return {
    agent: correctAgent,
    needsHandoff: true,
    reason: `stage_transition: lead moved to "${leadStatus}" which is handled by ${correctAgent}`,
  }
}

// ══════════════════════��══════════════════════���══════════════════
// BUILD HANDOFF CONTEXT
// ═══════���═══════════════════════════════════��════════════════════

/**
 * Assembles the context package transferred to the receiving agent
 * during a handoff. Pulls from patient profile, conversation analyses,
 * and lead data.
 */
export async function buildHandoffContext(
  supabase: SupabaseClient,
  leadId: string,
  conversationId: string,
  lead: Record<string, unknown>
): Promise<HandoffContextSnapshot> {
  // Fetch patient profile
  const { data: profile } = await supabase
    .from('patient_profiles')
    .select('*')
    .eq('lead_id', leadId)
    .single()

  // Fetch most recent conversation analysis
  const { data: analysis } = await supabase
    .from('conversation_analyses')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  const patientProfile = profile as PatientProfile | null

  return {
    patient_psychology_summary: patientProfile?.ai_summary || null,
    addressed_objections: patientProfile?.objections
      ?.filter((o: { addressed: boolean }) => o.addressed)
      .map((o: { objection: string }) => o.objection) || [],
    unresolved_objections: patientProfile?.objections
      ?.filter((o: { addressed: boolean }) => !o.addressed)
      .map((o: { objection: string }) => o.objection) || [],
    rapport_level: patientProfile?.rapport_score || 0,
    trust_level: patientProfile?.trust_level || 'unknown',
    key_pain_points: patientProfile?.pain_points
      ?.slice(0, 5)
      .map((p: { point: string }) => p.point) || [],
    conversation_summary: analysis?.coaching_notes || patientProfile?.next_best_action || 'No analysis available',
    recommended_approach: patientProfile?.recommended_tone || null,
    key_moments: patientProfile?.key_moments || [],
    qualification_data: {
      dental_condition: (lead.dental_condition as string) || null,
      timeline: (lead.consultation_date as string) || (lead.treatment_date as string) || null,
      financing_interest: (lead.financing_interest as string) || null,
      budget_range: (lead.budget_range as string) || null,
      decision_makers_identified: false,
    },
  }
}

// ════���══════════════════════════════════════════════���════════════
// EXECUTE HANDOFF
// ══��════════════════���═══════════════════════════��════════════════

/**
 * Executes an agent handoff: records the transition, updates the
 * conversation, and logs the activity.
 */
export async function executeHandoff(
  supabase: SupabaseClient,
  config: {
    organization_id: string
    conversation_id: string
    lead_id: string
    from_agent: AgentType
    to_agent: AgentType
    trigger_reason: string
    initiated_by: 'system' | 'user' | 'ai'
    initiated_by_user_id?: string
    lead: Record<string, unknown>
  }
): Promise<void> {
  // Build the context snapshot for the receiving agent
  const contextSnapshot = await buildHandoffContext(
    supabase,
    config.lead_id,
    config.conversation_id,
    config.lead
  )

  // Insert handoff record
  await supabase.from('agent_handoffs').insert({
    organization_id: config.organization_id,
    conversation_id: config.conversation_id,
    lead_id: config.lead_id,
    from_agent: config.from_agent,
    to_agent: config.to_agent,
    trigger_reason: config.trigger_reason,
    context_snapshot: contextSnapshot,
    initiated_by: config.initiated_by,
    initiated_by_user_id: config.initiated_by_user_id || null,
  })

  // Update conversation with new active agent
  await supabase
    .from('conversations')
    .update({
      active_agent: config.to_agent,
      agent_assigned_at: new Date().toISOString(),
      // agent_handoff_count incremented below via RPC
    })
    .eq('id', config.conversation_id)

  // Increment handoff count
  try {
    await supabase.rpc('increment_column', {
      table_name: 'conversations',
      column_name: 'agent_handoff_count',
      row_id: config.conversation_id,
    })
  } catch {
    // If RPC doesn't exist, do a manual update
    const { data } = await supabase
      .from('conversations')
      .select('agent_handoff_count')
      .eq('id', config.conversation_id)
      .single()
    if (data) {
      await supabase
        .from('conversations')
        .update({ agent_handoff_count: ((data as { agent_handoff_count: number }).agent_handoff_count || 0) + 1 })
        .eq('id', config.conversation_id)
    }
  }

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: config.organization_id,
    lead_id: config.lead_id,
    activity_type: 'agent_handoff',
    title: `AI Agent handoff: ${config.from_agent} → ${config.to_agent}`,
    description: config.trigger_reason,
    metadata: {
      from_agent: config.from_agent,
      to_agent: config.to_agent,
      trigger_reason: config.trigger_reason,
      initiated_by: config.initiated_by,
    },
  })

  // HIPAA audit log
  await logHIPAAEvent(supabase, {
    organization_id: config.organization_id,
    event_type: 'agent_handoff',
    severity: 'info',
    actor_type: 'ai_agent',
    actor_id: config.from_agent,
    resource_type: 'conversation',
    resource_id: config.conversation_id,
    description: `Agent handoff from ${config.from_agent} to ${config.to_agent}: ${config.trigger_reason}`,
    metadata: {
      from_agent: config.from_agent,
      to_agent: config.to_agent,
      initiated_by: config.initiated_by,
    },
  })
}

// ═══════════════════════��════════════════════════════��═══════════
// MAIN ROUTER
// ══════���═════════════════════════���══════════════════════���════════

/**
 * Main entry point for the agent system.
 *
 * 1. Determines the correct agent based on lead status
 * 2. Executes handoff if needed
 * 3. Calls the appropriate agent
 * 4. If the agent suggests a handoff, validates and queues it for next turn
 *
 * This function is called by:
 * - The Twilio webhook for auto-responses
 * - The /api/ai/agent-respond endpoint for manual AI drafts
 */
export async function routeToAgent(
  supabase: SupabaseClient,
  context: AgentContext
): Promise<AgentResponse> {
  // Fetch current conversation state
  const { data: conversation } = await supabase
    .from('conversations')
    .select('active_agent, agent_handoff_count')
    .eq('id', context.conversation_id)
    .single()

  const currentAgent: AgentType = (conversation?.active_agent as AgentType) || 'setter'

  // Determine if we need to switch agents
  const routing = determineActiveAgent(currentAgent, context.lead_status)

  // Execute handoff if the lead has moved to a different stage
  if (routing.needsHandoff && routing.reason) {
    await executeHandoff(supabase, {
      organization_id: context.organization_id,
      conversation_id: context.conversation_id,
      lead_id: context.lead.id!,
      from_agent: currentAgent,
      to_agent: routing.agent,
      trigger_reason: routing.reason,
      initiated_by: 'system',
      lead: context.lead as Record<string, unknown>,
    })
  }

  const activeAgent = routing.agent

  // Route to the correct agent
  let response: AgentResponse

  try {
    if (activeAgent === 'setter') {
      response = await setterAgentRespond(supabase, context)
    } else if (activeAgent === 'closer') {
      response = await closerAgentRespond(supabase, context)
    } else {
      // Agent is 'none' — lead is in a completed/lost stage
      // Fall back to generic engagement as a safety net
      const fallback = await generateLeadEngagement(
        context.lead,
        context.conversation_history,
        { mode: 'follow_up', channel: context.channel === 'email' ? 'email' : 'sms' },
        supabase
      )
      response = {
        message: fallback.message,
        confidence: fallback.confidence,
        agent: 'none',
        action_taken: 'responded',
        should_handoff: false,
      }
    }
  } catch (error) {
    // If agent fails, fall back to generic engagement
    console.error(`[Agent System] ${activeAgent} agent failed, falling back:`, error)
    const fallback = await generateLeadEngagement(
      context.lead,
      context.conversation_history,
      { mode: 'education', channel: context.channel === 'email' ? 'email' : 'sms' },
      supabase
    )
    response = {
      message: fallback.message,
      confidence: fallback.confidence * 0.8, // Lower confidence for fallback
      agent: activeAgent,
      action_taken: 'responded',
      should_handoff: false,
      internal_notes: `Agent failed, used fallback response. Error: ${error instanceof Error ? error.message : 'Unknown'}`,
    }
  }

  // If the AI suggests a handoff, validate and queue it for the NEXT turn
  if (response.should_handoff && response.handoff_reason) {
    const suggestedTarget = activeAgent === 'setter' ? 'closer' : 'setter'
    const targetForStage = STAGE_AGENT_MAP[context.lead_status]

    // Only execute AI-suggested handoff if the suggested target makes sense
    // (don't let the AI override stage-based routing arbitrarily)
    if (suggestedTarget !== activeAgent && (suggestedTarget === targetForStage || targetForStage === activeAgent)) {
      await executeHandoff(supabase, {
        organization_id: context.organization_id,
        conversation_id: context.conversation_id,
        lead_id: context.lead.id!,
        from_agent: activeAgent,
        to_agent: suggestedTarget,
        trigger_reason: `ai_suggestion: ${response.handoff_reason}`,
        initiated_by: 'ai',
        lead: context.lead as Record<string, unknown>,
      })
    }
  }

  return response
}

// ��═════════════════════════════���═════════════════════════════════
// HELPER: Fetch handoff history for a conversation
// ════��═══════════════════════════════════════════════════════════

export async function getHandoffHistory(
  supabase: SupabaseClient,
  conversationId: string
): Promise<HandoffRecord[]> {
  const { data } = await supabase
    .from('agent_handoffs')
    .select('from_agent, to_agent, trigger_reason, context_snapshot, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })

  return (data || []) as HandoffRecord[]
}
