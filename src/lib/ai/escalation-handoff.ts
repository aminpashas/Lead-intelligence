/**
 * Draft-gate escalation handoff.
 *
 * When the pre-generation draft gate (`assessDraftGate`) blocks with
 * kind === 'escalation', the AI has declined to draft because the lead is in
 * distress / trust has collapsed and a human should reach out. Historically the
 * agent-respond route returned that verdict as JSON and stopped — nothing was
 * persisted and no human was told, so the escalation lived only in the banner of
 * whoever happened to click "AI Agent Draft" and evaporated when they navigated
 * away.
 *
 * This module routes that verdict into the SAME escalation spine the autopilot
 * uses (`createEscalation`): it persists an `escalations` row (+ a lead activity)
 * and notifies staff assignee-first (push / SMS / email). It is idempotent
 * within a conversation — if an unresolved escalation already exists for the
 * thread, it refuses to stack another. Best-effort: it never throws.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createEscalation } from '@/lib/autopilot/escalation'
import { logger } from '@/lib/logger'

/** Escalations still awaiting a human — don't stack a duplicate on top. */
const OPEN_ESCALATION_STATUSES = ['pending', 'claimed']

export type EscalateBlockedDraftInput = {
  organizationId: string
  conversationId: string
  leadId: string
  /** Staff-facing reason from the gate (why drafting was suppressed). */
  reason: string
  /** Recovery guidance from the analysis panel, when available. */
  guidance?: string | null
  /** Which agent was about to draft ('setter' | 'closer'), when known. */
  agentType?: string | null
}

export type EscalateBlockedDraftResult = {
  escalationId: string | null
  /** True when an open escalation already existed and none was created. */
  deduped: boolean
}

/**
 * Persist + notify for a draft-gate escalation. Idempotent per conversation.
 *
 * Pass a SERVICE-ROLE client: the notification stack writes push_subscriptions
 * / notification_log rows that RLS reserves for the service role, and the
 * escalation dedupe check must see rows across the org regardless of the
 * caller's own RLS scope.
 */
export async function escalateBlockedDraft(
  supabase: SupabaseClient,
  input: EscalateBlockedDraftInput
): Promise<EscalateBlockedDraftResult> {
  try {
    // ── Idempotency: at most one live escalation per conversation ──────
    const { data: existing } = await supabase
      .from('escalations')
      .select('id')
      .eq('organization_id', input.organizationId)
      .eq('conversation_id', input.conversationId)
      .in('status', OPEN_ESCALATION_STATUSES)
      .limit(1)
      .maybeSingle()

    if (existing?.id) {
      return { escalationId: existing.id as string, deduped: true }
    }

    const aiNotes = input.guidance
      ? `${input.reason}\n\nSuggested next step: ${input.guidance}`
      : input.reason

    const escalationId = await createEscalation(supabase, {
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      lead_id: input.leadId,
      // The gate fires on distress / collapsed trust — 'sentiment_drop' is the
      // closest reason in the shared escalation taxonomy.
      reason: 'sentiment_drop',
      ai_notes: aiNotes,
      agent_type: input.agentType ?? undefined,
      priority: 'high',
    })

    return { escalationId, deduped: false }
  } catch (err) {
    logger.warn('EscalationHandoff: escalateBlockedDraft failed', {
      conversationId: input.conversationId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { escalationId: null, deduped: false }
  }
}
