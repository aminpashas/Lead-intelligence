/**
 * Place an outbound Retell call to a lead, gated by voice consent.
 *
 * Used by the campaign step executor when a campaign step has channel='voice'
 * (e.g. Day 10 of the seeded Reactivation sequence). The consent gate refuses
 * the call when:
 *   - voice_consent is not true
 *   - voice_opt_out is true
 *   - do_not_call is true (federal DNC list flag)
 *
 * Brief reference: §3.6 — "Outbound Vapi calls must check consent_log for voice
 * channel and respect DNC regardless of TCPA exemption for existing customers."
 *
 * Returns a uniform result so the executor can record success/failure consistently.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createOutboundCall, type RetellCallResponse } from './retell-client'
import { assertConsent, logConsentViolation, type ConsentDenyReason } from '@/lib/consent/gate'
import { messagingDryRun, isSendAllowed } from '@/lib/messaging/test-allowlist'
import { decryptField } from '@/lib/encryption'
import { logger } from '@/lib/logger'
import { recordAudit } from '@/lib/audit/record'
import { buildDateDynamicVariables } from '@/lib/ai/datetime-context'

export type OutboundToLeadResult =
  | { placed: true; call: RetellCallResponse }
  | { placed: false; reason: ConsentDenyReason | 'no_phone' | 'no_agent' | 'no_from_number' | 'retell_error' | 'dry_run' | 'not_allowlisted'; detail?: string }

export type OutboundToLeadParams = {
  supabase: SupabaseClient
  leadId: string
  organizationId: string
  /**
   * Reason this call is being placed — propagated to Retell as call metadata
   * so the post-call webhook can branch on it. e.g. 'reactivation_day_10'.
   */
  caller: string
  /**
   * Dynamic variables passed to the Retell agent so the prompt can interpolate
   * patient first name, original inquiry, etc. Optional.
   */
  dynamicVariables?: Record<string, string>
  /**
   * Optional override of the agent ID. Defaults to env RETELL_OUTBOUND_AGENT_ID
   * (or RETELL_AGENT_ID if outbound-specific isn't configured).
   */
  agentIdOverride?: string
}

export async function placeOutboundCallToLead(
  params: OutboundToLeadParams
): Promise<OutboundToLeadResult> {
  const decision = await assertConsent(params.supabase, params.leadId, 'voice')
  if (!decision.allowed) {
    await logConsentViolation(params.supabase, {
      organizationId: decision.lead?.organization_id ?? params.organizationId,
      leadId: params.leadId,
      channel: 'voice',
      reason: decision.reason,
      caller: params.caller,
    })
    return { placed: false, reason: decision.reason }
  }

  // Look up lead phone (decrypt if needed) + the org's outbound caller-ID number.
  const { data: lead } = await params.supabase
    .from('leads')
    .select('id, first_name, last_name, phone, phone_formatted')
    .eq('id', params.leadId)
    .single()

  if (!lead) return { placed: false, reason: 'no_phone' }

  const rawPhone = (lead.phone_formatted as string | null) || (lead.phone as string | null)
  const phone = rawPhone ? decryptField(rawPhone) || rawPhone : null
  if (!phone) return { placed: false, reason: 'no_phone' }

  // Global send kill-switch parity with SMS/email. The MESSAGING_DRY_RUN /
  // TEST_SEND_ALLOWLIST clamps live inside sendSMS/sendEmail, but Retell is a
  // separate transport — without this check a stray campaign voice step or a
  // replayed event could place a live call while the company believes all
  // messaging is frozen. One switch must stop all three channels.
  if (messagingDryRun()) {
    logger.warn('MESSAGING_DRY_RUN active — outbound voice call suppressed (not placed)', {
      leadId: params.leadId,
      caller: params.caller,
    })
    return { placed: false, reason: 'dry_run' }
  }
  if (!isSendAllowed(phone)) {
    logger.warn('TEST_SEND_ALLOWLIST active — outbound voice call suppressed (number not allowlisted)', {
      leadId: params.leadId,
      caller: params.caller,
    })
    return { placed: false, reason: 'not_allowlisted' }
  }

  const { data: org } = await params.supabase
    .from('organizations')
    .select('twilio_phone_number')
    .eq('id', params.organizationId)
    .single()

  const fromNumber = (org?.twilio_phone_number as string | null) || process.env.TWILIO_PHONE_NUMBER
  if (!fromNumber) return { placed: false, reason: 'no_from_number' }

  const agentId =
    params.agentIdOverride ||
    process.env.RETELL_OUTBOUND_AGENT_ID ||
    process.env.RETELL_AGENT_ID
  if (!agentId) return { placed: false, reason: 'no_agent' }

  // Practice-timezone clock + dated calendar for the hosted voice agent.
  const { data: bsForTz } = await params.supabase
    .from('booking_settings')
    .select('timezone')
    .eq('organization_id', params.organizationId)
    .maybeSingle()
  const dateVars = buildDateDynamicVariables((bsForTz?.timezone as string | null) ?? null)

  // Open or find the active voice conversation so the post-call webhook can attach the transcript.
  const conversationId = await ensureVoiceConversation(
    params.supabase,
    params.organizationId,
    params.leadId
  )

  try {
    const call = await createOutboundCall(agentId, {
      from_number: fromNumber,
      to_number: phone,
      metadata: {
        organization_id: params.organizationId,
        lead_id: params.leadId,
        conversation_id: conversationId ?? '',
        caller: params.caller,
      },
      // Variable names MUST match the Retell hosted-LLM prompt ({{caller_*}} +
      // {{call_direction}}). Populating the name on this outbound path stops the
      // agent from opening with "thanks for calling" / re-asking a name we know.
      retell_llm_dynamic_variables: {
        call_direction: 'outbound',
        caller_first_name: (lead.first_name as string) || '',
        caller_full_name:
          `${(lead.first_name as string) || ''} ${(lead.last_name as string) || ''}`.trim() || '',
        is_new_lead: 'false',
        is_returning: 'true',
        // Back-compat: some older prompt copies still read {{first_name}}.
        first_name: (lead.first_name as string) || 'there',
        // Real clock + dated 2-week calendar. Retell prompt references
        // {{current_datetime}} and {{upcoming_dates}}.
        ...dateVars,
        ...(params.dynamicVariables || {}),
      },
    })

    // Record an outbound message marker so the timeline shows the call attempt
    // even before the post-call webhook hydrates the full transcript.
    if (conversationId) {
      await params.supabase.from('messages').insert({
        organization_id: params.organizationId,
        conversation_id: conversationId,
        lead_id: params.leadId,
        direction: 'outbound',
        channel: 'voice',
        body: `Outbound voice call placed (${params.caller})`,
        sender_type: 'ai',
        status: 'sent',
        external_id: call.call_id || null,
        ai_generated: true,
        metadata: { caller: params.caller, retell_call_id: call.call_id },
      })
    }

    // Audit trail: best-effort, fire-and-forget — never blocks or alters the call result.
    void recordAudit(params.supabase, {
      organizationId: params.organizationId,
      action: 'call.placed',
      actor: { actorType: 'ai_agent', actorId: null, actorLabel: 'AI Voice Agent' },
      source: 'cron',
      resourceType: 'lead',
      resourceId: params.leadId,
      ai: { autonomous: true, agent_role: 'voice', model: agentId },
      metadata: { caller: params.caller, retell_call_id: call.call_id ?? null },
    })

    return { placed: true, call }
  } catch (err) {
    logger.warn('Outbound Retell call failed', {
      leadId: params.leadId,
      caller: params.caller,
      err: err instanceof Error ? err.message : String(err),
    })
    return {
      placed: false,
      reason: 'retell_error',
      detail: err instanceof Error ? err.message : 'unknown',
    }
  }
}

async function ensureVoiceConversation(
  supabase: SupabaseClient,
  organizationId: string,
  leadId: string
): Promise<string | null> {
  try {
    const { data: existing } = await supabase
      .from('conversations')
      .select('id')
      .eq('lead_id', leadId)
      .eq('channel', 'voice')
      .eq('status', 'active')
      .limit(1)
      .single()
    if (existing?.id) return existing.id as string

    const { data: created } = await supabase
      .from('conversations')
      .insert({
        organization_id: organizationId,
        lead_id: leadId,
        channel: 'voice',
        status: 'active',
        ai_enabled: true,
        ai_mode: 'auto',
      })
      .select('id')
      .single()
    return (created?.id as string) || null
  } catch {
    return null
  }
}
