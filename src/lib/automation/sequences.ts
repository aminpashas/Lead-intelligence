/**
 * Outreach sequence engine — loads DB-defined sequences and executes a single
 * step against a lead.
 *
 * Ownership model (per step):
 *   owner='human' or channel human_call/human_task → human_tasks queue entry
 *   owner='ai' + sms/email → AI-composed (setter agent, guided by step.intent)
 *                            or template send; consent/allowlist/dry-run gates
 *                            enforced inside sendSMSToLead / sendEmailToLead
 *   owner='ai' + ai_call   → Retell outbound call IF SEQUENCE_AI_CALLS_ENABLED
 *                            and preCallCheck pass; otherwise falls back to a
 *                            human call task so the touch is never dropped
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  OutreachSequence,
  OutreachSequenceStep,
  ConversationChannel,
  LeadStatus,
  Lead,
} from '@/types/database'
import type { SchedulableStep } from './sequence-schedule'
import { stepDedupeKey } from './sequence-schedule'
import { createHumanTask, resolveAssignee } from './tasks'
import { getAutopilotConfig } from '@/lib/autopilot/config'
import { routeToAgent } from '@/lib/ai/agent-handoff'
import { canDisclosePHI } from '@/lib/ai/identity-verification'
import { getAgentIdForRole } from '@/lib/agents/agent-resolver'
import type { AgentContext, ConversationMessage } from '@/lib/ai/agent-types'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { sendEmailToLead } from '@/lib/messaging/resend'
import { decryptField } from '@/lib/encryption'
import { logger } from '@/lib/logger'

export type SequenceWithSteps = OutreachSequence & { steps: OutreachSequenceStep[] }

/** Load one sequence (with ordered steps) for an org; null when undefined. */
export async function loadSequence(
  supabase: SupabaseClient,
  organizationId: string,
  key: string
): Promise<SequenceWithSteps | null> {
  const { data: seq, error } = await supabase
    .from('outreach_sequences')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('key', key)
    .maybeSingle()
  if (error || !seq) return null

  const { data: steps } = await supabase
    .from('outreach_sequence_steps')
    .select('*')
    .eq('sequence_id', seq.id)
    .order('position', { ascending: true })

  return { ...(seq as OutreachSequence), steps: (steps ?? []) as OutreachSequenceStep[] }
}

/** All sequences (with steps) for an org, for the Workflows tab. */
export async function loadAllSequences(
  supabase: SupabaseClient,
  organizationId: string
): Promise<SequenceWithSteps[]> {
  const { data: seqs, error } = await supabase
    .from('outreach_sequences')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: true })
  if (error || !seqs?.length) return []

  const { data: steps } = await supabase
    .from('outreach_sequence_steps')
    .select('*')
    .in('sequence_id', seqs.map((s) => s.id))
    .order('position', { ascending: true })

  const byseq = new Map<string, OutreachSequenceStep[]>()
  for (const st of (steps ?? []) as OutreachSequenceStep[]) {
    const arr = byseq.get(st.sequence_id) ?? []
    arr.push(st)
    byseq.set(st.sequence_id, arr)
  }
  return (seqs as OutreachSequence[]).map((s) => ({ ...s, steps: byseq.get(s.id) ?? [] }))
}

/**
 * Auto-enroll a fresh lead in the org's new_lead_follow_up sequence (one
 * active enrollment per lead). No-op unless the sequence exists and is
 * enabled; the cron is additionally env-gated (FOLLOWUP_SEQUENCES_ENABLED).
 */
export async function enrollLeadInFollowUp(
  supabase: SupabaseClient,
  leadId: string,
  organizationId: string
): Promise<{ enrolled: boolean; reason?: string }> {
  const seq = await loadSequence(supabase, organizationId, 'new_lead_follow_up')
  if (!seq?.enabled) return { enrolled: false, reason: 'sequence_disabled_or_missing' }

  const { error } = await supabase.from('follow_up_enrollments').upsert(
    {
      organization_id: organizationId,
      lead_id: leadId,
      sequence_id: seq.id,
      status: 'active',
      current_step: 0,
      enrolled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'lead_id', ignoreDuplicates: true }
  )
  if (error) {
    logger.warn('Follow-up auto-enroll failed', { leadId, error: error.message })
    return { enrolled: false, reason: error.message }
  }
  return { enrolled: true }
}

// ── Step execution ───────────────────────────────────────────────────

export type StepExecutionContext = {
  organizationId: string
  /** Full lead row (encrypted fields still encrypted — decrypted here). */
  lead: Record<string, unknown>
  step: SchedulableStep
  /** Enrollment or appointment id — scopes the task dedupe key. */
  scopeId: string
  source: 'follow_up_sequence' | 'appointment_sequence'
  /**
   * Pre-rendered copy (appointment reminders render exact date/time templates
   * upstream). When set, skips AI composition entirely.
   */
  prepared?: { subject?: string; html?: string; text?: string; smsBody?: string }
}

export type StepExecutionResult = {
  status: 'sent' | 'task_created' | 'call_initiated' | 'escalated' | 'skipped' | 'failed'
  channel: SchedulableStep['channel']
  detail?: string
}

export async function executeSequenceStep(
  supabase: SupabaseClient,
  ctx: StepExecutionContext
): Promise<StepExecutionResult> {
  const { step, lead, organizationId } = ctx
  const leadId = lead.id as string
  const rawFirst = (lead.first_name as string) || ''
  const firstName = decryptField(rawFirst) || rawFirst || 'the lead'

  // Human-owned steps and explicitly-human channels → tasks queue.
  if (step.owner === 'human' || step.channel === 'human_call' || step.channel === 'human_task') {
    return createStepTask(supabase, ctx, firstName, null)
  }

  if (step.channel === 'ai_call') {
    return executeAICallStep(supabase, ctx, firstName)
  }

  // AI-owned SMS/email.
  return executeAIMessageStep(supabase, ctx, firstName)
}

/** Queue the step for a human (also the fallback when AI voice is gated off). */
async function createStepTask(
  supabase: SupabaseClient,
  ctx: StepExecutionContext,
  firstName: string,
  fallbackNote: string | null
): Promise<StepExecutionResult> {
  const { step, organizationId } = ctx
  const leadId = ctx.lead.id as string
  const isCall = step.channel === 'human_call' || step.channel === 'ai_call'
  const assignee = await resolveAssignee(supabase, organizationId, leadId)

  const { taskId } = await createHumanTask(supabase, {
    organization_id: organizationId,
    kind: 'nurture_step',
    title: isCall ? `Call ${firstName}` : `Follow up with ${firstName}`,
    detail: [step.intent, fallbackNote].filter(Boolean).join('\n\n') || null,
    source: ctx.source,
    lead_id: leadId,
    assigned_to: assignee.userId,
    assigned_role: assignee.role,
    dedupe_key: stepDedupeKey(ctx.scopeId, step.id),
    metadata: {
      sequence_step_id: step.id,
      channel: step.channel,
      owner: step.owner,
      offset_minutes: step.offset_minutes,
    },
  })

  return taskId
    ? { status: 'task_created', channel: step.channel }
    : { status: 'failed', channel: step.channel, detail: 'task_create_failed' }
}

/** AI voice step: Retell outbound when enabled + compliant, else human task. */
async function executeAICallStep(
  supabase: SupabaseClient,
  ctx: StepExecutionContext,
  firstName: string
): Promise<StepExecutionResult> {
  const { step, organizationId } = ctx
  const leadId = ctx.lead.id as string

  if (process.env.SEQUENCE_AI_CALLS_ENABLED !== 'true') {
    return createStepTask(
      supabase,
      ctx,
      firstName,
      'AI voice is currently disabled — this AI call step needs a manual call.'
    )
  }

  // Lazy import keeps Retell/Twilio voice deps out of non-voice paths.
  const { preCallCheck, initiateOutboundCall } = await import('@/lib/voice/call-manager')
  const check = await preCallCheck(supabase, leadId, organizationId)
  if (!check.allowed || !check.phone) {
    // DNC / no consent / bad number: never route around a compliance gate to a
    // human dial — skip outright.
    logger.info('Sequence AI call skipped by pre-call check', { leadId, reason: check.reason })
    return { status: 'skipped', channel: 'ai_call', detail: check.reason }
  }

  try {
    await initiateOutboundCall(supabase, {
      organization_id: organizationId,
      lead_id: leadId,
      lead: ctx.lead,
      phone: check.phone,
      agent_type: 'setter',
    })
    return { status: 'call_initiated', channel: 'ai_call' }
  } catch (error) {
    logger.error('Sequence AI call failed', { leadId }, error instanceof Error ? error : undefined)
    return createStepTask(supabase, ctx, firstName, 'AI call attempt failed — please call manually.')
  }
}

/** AI-owned SMS/email: template if provided, else setter-composed. */
async function executeAIMessageStep(
  supabase: SupabaseClient,
  ctx: StepExecutionContext,
  firstName: string
): Promise<StepExecutionResult> {
  const { step, lead, organizationId } = ctx
  const leadId = lead.id as string
  const channel = step.channel as 'sms' | 'email'

  // Consent assumed — reachable on a channel with an address and no opt-out (DND).
  const hasPhone = lead.phone_formatted && !lead.sms_opt_out
  const hasEmail = lead.email && !lead.email_opt_out
  const recipient =
    channel === 'sms'
      ? hasPhone
        ? decryptField(lead.phone_formatted as string) || (lead.phone_formatted as string)
        : null
      : hasEmail
        ? decryptField(lead.email as string) || (lead.email as string)
        : null
  if (!recipient) {
    return { status: 'skipped', channel, detail: 'no_contact_or_consent' }
  }

  // Resolve copy: prepared (appointment templates) > fixed template > AI compose.
  let body: string | null = ctx.prepared?.smsBody ?? ctx.prepared?.text ?? null
  const subject = ctx.prepared?.subject ?? step.template_subject ?? 'Following up'
  const html = ctx.prepared?.html ?? null
  let aiConfidence: number | null = null
  let conversationId: string | null = null

  if (!body && step.template_body) {
    body = step.template_body.replace(/\{first(_name)?\}/g, firstName)
  }

  if (!body) {
    const composed = await composeOutreachMessage(supabase, {
      lead,
      organizationId,
      channel,
      intent: step.intent,
    })
    if (composed) {
      const config = await getAutopilotConfig(supabase, organizationId)
      if (composed.confidence < config.confidence_threshold) {
        // Not confident enough to auto-send — hand the draft to a human.
        const assignee = await resolveAssignee(supabase, organizationId, leadId)
        await createHumanTask(supabase, {
          organization_id: organizationId,
          kind: 'nurture_step',
          title: `Review outreach draft for ${firstName}`,
          detail: step.intent,
          ai_draft: composed.message,
          source: ctx.source,
          lead_id: leadId,
          conversation_id: composed.conversationId,
          assigned_to: assignee.userId,
          assigned_role: assignee.role,
          dedupe_key: stepDedupeKey(ctx.scopeId, step.id),
          metadata: { sequence_step_id: step.id, ai_confidence: composed.confidence },
        })
        return { status: 'escalated', channel, detail: 'low_confidence' }
      }
      body = composed.message
      aiConfidence = composed.confidence
      conversationId = composed.conversationId
    }
  }

  if (!body) {
    // AI compose unavailable and no template — generic fallback keeps the
    // cadence alive rather than silently dropping the touch.
    body =
      channel === 'sms'
        ? `Hi ${firstName}, following up from the dental implant team — want to book your free consult? Reply YES and we'll set it up.`
        : `Hi ${firstName}, just circling back — we'd love to help you explore dental implants. Want to book a free consultation? Reply anytime and we'll get you scheduled.`
  }

  try {
    let externalId: string | undefined
    if (channel === 'sms') {
      const r = await sendSMSToLead({
        supabase,
        leadId,
        to: recipient,
        body,
        caller: ctx.source,
        aiGenerated: true,
      })
      if (!r.sent) return { status: 'skipped', channel, detail: r.reason }
      externalId = r.sid
    } else {
      const r = await sendEmailToLead({
        supabase,
        leadId,
        to: recipient,
        subject,
        html: html ?? `<div style="font-family: -apple-system, sans-serif; padding: 24px;">${body.replace(/\n/g, '<br>')}</div>`,
        text: body,
        caller: ctx.source,
        aiGenerated: true,
      })
      if (!r.sent) return { status: 'skipped', channel, detail: r.reason }
    }

    // Thread AI-composed sends into the conversation like speed-to-lead does.
    if (conversationId) {
      const agentId = await getAgentIdForRole(supabase, organizationId, 'setter')
      await supabase.from('messages').insert({
        organization_id: organizationId,
        conversation_id: conversationId,
        lead_id: leadId,
        agent_id: agentId,
        direction: 'outbound',
        channel,
        body,
        sender_type: 'ai',
        status: 'sent',
        external_id: externalId || null,
        ai_generated: true,
        ai_confidence: aiConfidence,
        metadata: { sequence_step_id: step.id, source: ctx.source },
      })
    }

    await supabase
      .from('leads')
      .update({ last_contacted_at: new Date().toISOString() })
      .eq('id', leadId)

    return { status: 'sent', channel }
  } catch (error) {
    logger.error(
      'Sequence step send failed',
      { leadId, channel },
      error instanceof Error ? error : undefined
    )
    return { status: 'failed', channel, detail: error instanceof Error ? error.message : 'unknown' }
  }
}

/**
 * Compose a proactive outreach message with the setter agent, threaded into
 * the lead's conversation (created if missing). Returns null on agent failure
 * so callers can fall back to template copy.
 */
async function composeOutreachMessage(
  supabase: SupabaseClient,
  params: {
    lead: Record<string, unknown>
    organizationId: string
    channel: 'sms' | 'email'
    intent: string | null
  }
): Promise<{ message: string; confidence: number; conversationId: string } | null> {
  const { lead, organizationId, channel } = params
  const leadId = lead.id as string

  try {
    let conversationId: string
    const { data: existing } = await supabase
      .from('conversations')
      .select('id')
      .eq('lead_id', leadId)
      .eq('channel', channel)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle()

    if (existing) {
      conversationId = existing.id
    } else {
      const { data: created, error } = await supabase
        .from('conversations')
        .insert({
          organization_id: organizationId,
          lead_id: leadId,
          channel,
          status: 'active',
          ai_enabled: true,
          ai_mode: 'auto',
          active_agent: 'setter',
        })
        .select('id')
        .single()
      if (error || !created) return null
      conversationId = created.id
    }

    const { data: history } = await supabase
      .from('messages')
      .select('direction, body')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(10)

    const conversationHistory: ConversationMessage[] = (history ?? [])
      .reverse()
      .map((m) => ({
        role: m.direction === 'inbound' ? ('user' as const) : ('assistant' as const),
        content: (m.body as string) || '',
      }))
      .filter((m) => m.content)

    const context: AgentContext = {
      lead: lead as unknown as Partial<Lead>,
      conversation_id: conversationId,
      organization_id: organizationId,
      channel: channel as ConversationChannel,
      lead_status: ((lead.status as string) || 'contacted') as LeadStatus,
      patient_profile: null,
      conversation_history: conversationHistory,
      handoff_history: [],
      message_count: conversationHistory.length,
      disclose_phi: canDisclosePHI({ lead, verifiedAt: null, channel }),
      outreach_instruction:
        params.intent ||
        'Proactive follow-up: the lead has not replied yet. Write a short, warm nudge toward booking a consultation.',
    }

    const response = await routeToAgent(supabase, context)
    if (!response?.message) return null
    return { message: response.message, confidence: response.confidence, conversationId }
  } catch (error) {
    logger.warn('Sequence AI compose failed, falling back to template', {
      leadId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
