/**
 * Post-Consult Funding Nurture — step executor.
 *
 * Owns the full lifecycle of ONE step of the post-consult funding nurture,
 * kept separate from the generic campaign executor so its special behavior can't
 * regress other campaigns. Differences from the generic path:
 *   - AI steps are composed by the objection-aware CLOSER agent (proactive,
 *     tools-disabled) instead of the thin default generator.
 *   - Financing-aware `send_condition`: funding-help steps are SKIPPED (advanced
 *     past) once the patient's financing is approved.
 *   - Consent is skip-not-exit: a lead with no SMS consent skips SMS steps but
 *     stays enrolled for email steps (and vice-versa).
 *   - Autopilot-gated: respects outreach_suppressed (shadow mode), kill switch,
 *     confidence threshold, and review-closer mode — routing low-confidence /
 *     suppressed drafts to a human via an escalation instead of sending.
 *   - Step 6 appends a forwardable financing application link (co-signer path).
 *
 * The generic executor delegates here when the campaign is the seeded
 * post-consult nurture (campaigns.metadata->>'system_key').
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentContext, ConversationMessage } from '@/lib/ai/agent-types'
import type { PatientProfile, ConversationChannel, LeadStatus, FinancingContext } from '@/types/database'
import { processTemplate, buildTemplateContext } from './template'
import { parseBranding } from '@/lib/branding/schema'
import { checkSendWindow } from './send-window'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { sendEmailToLead } from '@/lib/messaging/resend'
import { enqueueCampaignReviewDraft } from '@/lib/campaigns/review-drafts'
import { decryptField } from '@/lib/encryption'
import { closerAgentRespond } from '@/lib/ai/closer-agent'
import { getPatientProfile } from '@/lib/ai/patient-psychology'
import { buildFinancingContext } from '@/lib/ai/financial-coach'
import { getAutopilotConfig, shouldAutoRespond, getLocalHourAndDay } from '@/lib/autopilot/config'
import { createEscalation, type EscalationReason } from '@/lib/autopilot/escalation'
import { resolveAutomationOwner } from '@/lib/automation/allocation'
import { getOrCreateFinancingShareLink } from '@/lib/financing/share-link'
import type { ExecutionResult } from './executor'

type Enrollment = {
  id: string
  organization_id: string
  lead_id: string
  current_step: number | null
  created_at: string
  campaign: Record<string, any>
  lead: Record<string, any>
}

const IDEMPOTENCY_LOCK_MS = 10 * 60 * 1000
const HOURS_DEFER_MS = 60 * 60 * 1000

/**
 * Execute the next due step of a post-consult nurture enrollment.
 */
export async function executeNurtureStep(
  supabase: SupabaseClient,
  enrollment: Enrollment
): Promise<ExecutionResult> {
  const campaign = enrollment.campaign
  const lead = enrollment.lead ? { ...enrollment.lead } : null
  const base = { enrollment_id: enrollment.id, lead_id: enrollment.lead_id }
  if (!campaign || !lead) return { ...base, action: 'error', detail: 'Missing campaign or lead' }

  const orgId: string = campaign.organization_id

  // Decrypt PII for sending / context.
  lead.phone_formatted = decryptField(lead.phone_formatted) || lead.phone_formatted
  lead.phone = decryptField(lead.phone) || lead.phone
  lead.email = decryptField(lead.email) || lead.email

  // Idempotency: atomically claim by pushing next_step_at into the future.
  const stepNumber = (enrollment.current_step || 0) + 1
  const { data: claimed } = await supabase
    .from('campaign_enrollments')
    .update({ next_step_at: new Date(Date.now() + IDEMPOTENCY_LOCK_MS).toISOString() })
    .eq('id', enrollment.id)
    .eq('current_step', enrollment.current_step)
    .lte('next_step_at', new Date().toISOString())
    .select('id')
    .single()
  if (!claimed) return { ...base, action: 'skipped', detail: 'Already being processed (idempotency)' }

  // Load the current step.
  const { data: step } = await supabase
    .from('campaign_steps')
    .select('*')
    .eq('campaign_id', campaign.id)
    .eq('step_number', stepNumber)
    .single()

  if (!step) return await completeEnrollment(supabase, campaign, enrollment, stepNumber, base)

  // Exit conditions (replied, or reached a converting/terminal status).
  if (step.exit_condition && shouldExit(step.exit_condition, lead, enrollment)) {
    await supabase.from('campaign_enrollments').update({
      status: 'exited', exited_at: new Date().toISOString(), exit_reason: 'Exit condition met',
    }).eq('id', enrollment.id)
    return { ...base, action: 'exited', detail: 'Exit condition met' }
  }

  const isAiStep = step.metadata?.ai_generator === 'closer'

  // Financing context — needed for the financing send-gate and for the closer.
  let financingCtx: FinancingContext | undefined
  if (isAiStep || step.send_condition?.if_financing_not_approved) {
    financingCtx = await buildFinancingContext(supabase, lead.id, orgId).catch(() => undefined)
  }

  // Financing-aware send condition: skip funding-help steps once approved.
  if (step.send_condition?.if_financing_not_approved && financingCtx?.status === 'approved') {
    return await advance(supabase, campaign, enrollment, stepNumber, base, 'financing_approved_skip')
  }

  // Consent is assumed — skip-not-exit only when the lead opted out (DND) or has no
  // address on this channel. A missing channel skips this step but keeps the lead enrolled.
  if (step.channel === 'sms' && (lead.sms_opt_out || !lead.phone_formatted)) {
    return await advance(supabase, campaign, enrollment, stepNumber, base, 'no_sms_channel_skip')
  }
  if (step.channel === 'email' && (lead.email_opt_out || !lead.email)) {
    return await advance(supabase, campaign, enrollment, stepNumber, base, 'no_email_channel_skip')
  }

  // Send window (business hours / days) — defer to the next valid time.
  const windowCheck = checkSendWindow(campaign.send_window)
  if (!windowCheck.allowed) {
    await supabase.from('campaign_enrollments').update({
      next_step_at: (windowCheck.nextValidTime ?? new Date(Date.now() + HOURS_DEFER_MS)).toISOString(),
    }).eq('id', enrollment.id)
    return { ...base, action: 'deferred', detail: 'Outside send window' }
  }

  // Resolve org name + branding + conversation up-front (needed for context, escalation, storage).
  const { data: org } = await supabase.from('organizations').select('name, settings').eq('id', orgId).single()
  const orgName = org?.name || 'Our Practice'
  const branding = parseBranding((org?.settings as Record<string, unknown> | null)?.branding)
  const conversationId = await getOrCreateConversation(supabase, orgId, lead.id, step.channel)

  // Compose the message — practice_name resolves to the lead's brand, not raw org name.
  const ctx = buildTemplateContext(lead, orgName, orgId, branding)
  let messageBody = processTemplate(step.body_template, ctx)
  const subject = step.subject ? processTemplate(step.subject, ctx) : `A note from ${orgName}`
  let confidence = 1 // fixed templates are trusted
  let internalNotes: string | undefined

  if (isAiStep) {
    try {
      const agentContext = await buildNurtureAgentContext(supabase, {
        lead, orgId, conversationId, channel: step.channel, financingCtx,
      })
      const resp = await closerAgentRespond(supabase, agentContext, {
        proactiveGoal: step.metadata?.nurture_goal || 'Warmly re-engage the patient toward funding their treatment.',
        disableTools: true,
      })
      messageBody = resp.message
      confidence = resp.confidence
      internalNotes = resp.internal_notes
    } catch {
      // Fall back to the fixed template copy (safe, on-policy) on any AI failure.
      confidence = 1
    }
  }

  // Co-signer step: append a forwardable financing application link.
  if (step.metadata?.append_financing_link) {
    const link = await getOrCreateFinancingShareLink(supabase, {
      organizationId: orgId,
      leadId: lead.id,
      requestedAmount: (lead.treatment_value as number) ?? null,
    }).catch(() => null)
    if (link) {
      messageBody += step.channel === 'email'
        ? `\n\nApply or share this secure link with your co-signer: ${link.url}`
        : `\n\nSecure application link (you or your co-signer can use it): ${link.url}`
    }
  }

  // ── Autopilot gate ────────────────────────────────────────────────
  const config = await getAutopilotConfig(supabase, orgId)

  // Shadow mode: never auto-send outreach — route the draft to a human.
  if (config.outreach_suppressed) {
    await escalateDraft(supabase, { orgId, conversationId, leadId: lead.id, reason: 'compliance_flag', confidence, internalNotes, note: 'OUTREACH SUPPRESSED (shadow mode) — nurture draft not sent.' })
    return await advance(supabase, campaign, enrollment, stepNumber, base, 'escalated_outreach_suppressed')
  }

  if (isAiStep) {
    // Allocation policy gate (Workstream D1, dormant by default): an AI step
    // allocated to a human (or human-first hold) routes the draft through the
    // existing escalation path instead of sending — same as shadow mode does.
    // With zero policy rows this always resolves to 'ai' (legacy path).
    const allocation = await resolveAutomationOwner(supabase, {
      organizationId: orgId,
      kind: 'nurture_step',
      campaignId: campaign.id,
    })
    if (allocation.owner !== 'ai') {
      // TODO(D2/D3 wiring point): create the human task + SLA timer for 'hold'.
      await escalateDraft(supabase, {
        orgId, conversationId, leadId: lead.id, reason: 'compliance_flag', confidence, internalNotes,
        note: `Allocated to human by automation policy (allocated_to_human: ${allocation.reason}) — nurture draft not auto-sent.`,
      })
      return await advance(supabase, campaign, enrollment, stepNumber, base, 'escalated_allocated_to_human')
    }

    const { hour: currentHour } = getLocalHourAndDay(config.timezone)
    const decision = shouldAutoRespond(config, {
      confidence, agentType: 'closer', isFirstMessage: false, currentHour,
    })
    if (!decision.allowed) {
      // Quiet-hours / day-off → defer (retry later). Everything else → human draft.
      if (isHoursReason(decision.reason)) {
        await supabase.from('campaign_enrollments').update({
          next_step_at: new Date(Date.now() + HOURS_DEFER_MS).toISOString(),
        }).eq('id', enrollment.id)
        return { ...base, action: 'deferred', detail: `autopilot: ${decision.reason}` }
      }
      await escalateDraft(supabase, { orgId, conversationId, leadId: lead.id, reason: mapReason(decision.reason), confidence, internalNotes, note: `Nurture draft not auto-sent: ${decision.reason}` })
      return await advance(supabase, campaign, enrollment, stepNumber, base, `escalated_${decision.reason}`)
    }
  } else {
    // Fixed template steps: only the kill switch / pause holds them for review.
    if (!config.enabled || config.paused) {
      await escalateDraft(supabase, { orgId, conversationId, leadId: lead.id, reason: 'compliance_flag', confidence, internalNotes, note: 'Autopilot disabled/paused — nurture draft held for review.' })
      return await advance(supabase, campaign, enrollment, stepNumber, base, 'escalated_autopilot_disabled')
    }
  }

  // review_first campaign mode: queue for human approval instead of sending,
  // then advance (same draft-and-move-on semantics as the allocation path above).
  if (campaign.autopilot_mode === 'review_first') {
    await enqueueCampaignReviewDraft(supabase, {
      organizationId: orgId,
      campaignId: campaign.id,
      leadId: lead.id,
      conversationId,
      channel: step.channel,
      subject: step.channel === 'email' ? (subject ?? null) : null,
      body: messageBody,
    })
    return await advance(supabase, campaign, enrollment, stepNumber, base, 'queued_for_review')
  }

  // ── Send ──────────────────────────────────────────────────────────
  let externalId: string | null = null
  if (step.channel === 'sms') {
    const res = await sendSMSToLead({
      supabase, leadId: lead.id, to: lead.phone_formatted, body: messageBody,
      caller: 'campaign.nurture', aiGenerated: isAiStep, blockOnReview: true,
    })
    if (!res.sent) {
      // Consent/compliance blocked at the gate — skip this step, keep enrolled.
      return await advance(supabase, campaign, enrollment, stepNumber, base, `sms_blocked_${res.reason}`)
    }
    externalId = res.sid
  } else {
    const html = `<div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">${messageBody.replace(/\n/g, '<br>')}</div>`
    const res = await sendEmailToLead({
      supabase, leadId: lead.id, to: lead.email, subject, html, text: messageBody,
      caller: 'campaign.nurture', aiGenerated: isAiStep, blockOnReview: true,
    })
    if (!res.sent) {
      return await advance(supabase, campaign, enrollment, stepNumber, base, `email_blocked_${res.reason}`)
    }
    externalId = res.id
  }

  // Store the outbound message + activity + step stats.
  await supabase.from('messages').insert({
    organization_id: orgId,
    conversation_id: conversationId,
    lead_id: lead.id,
    direction: 'outbound',
    channel: step.channel,
    body: messageBody,
    subject: step.channel === 'email' ? subject : null,
    sender_type: isAiStep ? 'ai' : 'system',
    status: 'sent',
    external_id: externalId,
    ai_generated: isAiStep,
    ai_confidence: isAiStep ? confidence : null,
    metadata: { campaign_id: campaign.id, step_number: step.step_number, nurture: true },
  })

  await supabase.from('lead_activities').insert({
    organization_id: orgId,
    lead_id: lead.id,
    activity_type: step.channel === 'sms' ? 'sms_sent' : 'email_sent',
    title: `Funding Nurture — Step ${step.step_number}: ${step.name || ''}`.trim(),
    description: messageBody.substring(0, 200),
    metadata: { campaign_id: campaign.id, step_number: step.step_number, nurture: true, ai: isAiStep },
  })

  await supabase.from('campaign_steps').update({ total_sent: (step.total_sent || 0) + 1 }).eq('id', step.id)
  await supabase.from('leads').update({ last_contacted_at: new Date().toISOString() }).eq('id', lead.id)

  const outcome = await advance(supabase, campaign, enrollment, stepNumber, base, 'sent')
  return { ...outcome, action: 'sent', detail: `${step.channel} nurture step ${step.step_number}` }
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Exit if the lead replied after enrolling, or reached a converting/terminal status. */
function shouldExit(condition: Record<string, unknown>, lead: any, enrollment: Enrollment): boolean {
  if (condition.if_replied && lead.last_responded_at) {
    if (new Date(lead.last_responded_at).getTime() > new Date(enrollment.created_at).getTime()) return true
  }
  if (Array.isArray(condition.if_status_in) && (condition.if_status_in as string[]).includes(lead.status)) return true
  return false
}

function isHoursReason(reason: string): boolean {
  return reason === 'outside_active_hours' || reason === 'outside_schedule_hours' || reason.startsWith('day_disabled_')
}

function mapReason(reason: string): EscalationReason {
  return reason === 'low_confidence' ? 'low_confidence' : 'compliance_flag'
}

async function getOrCreateConversation(
  supabase: SupabaseClient,
  orgId: string,
  leadId: string,
  channel: string
): Promise<string> {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .eq('lead_id', leadId)
    .eq('channel', channel)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle<{ id: string }>()
  if (existing?.id) return existing.id

  const { data: created } = await supabase
    .from('conversations')
    .insert({ organization_id: orgId, lead_id: leadId, channel, status: 'active', ai_enabled: true, ai_mode: 'auto' })
    .select('id')
    .single<{ id: string }>()
  return created!.id
}

async function buildNurtureAgentContext(
  supabase: SupabaseClient,
  params: {
    lead: Record<string, any>
    orgId: string
    conversationId: string
    channel: 'sms' | 'email'
    financingCtx?: FinancingContext
  }
): Promise<AgentContext> {
  const { lead, orgId, conversationId, channel, financingCtx } = params

  const { data: msgs } = await supabase
    .from('messages')
    .select('direction, body')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(20)

  const history: ConversationMessage[] = (msgs || []).map((m: any) => ({
    role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: m.body || '',
  }))

  const profile = (await getPatientProfile(supabase, lead.id).catch(() => null)) as PatientProfile | null

  return {
    lead,
    conversation_id: conversationId,
    organization_id: orgId,
    channel: channel as ConversationChannel,
    lead_status: lead.status as LeadStatus,
    patient_profile: profile,
    conversation_history: history,
    handoff_history: [],
    message_count: history.length,
    financing_context: financingCtx,
  }
}

async function escalateDraft(
  supabase: SupabaseClient,
  params: {
    orgId: string
    conversationId: string
    leadId: string
    reason: EscalationReason
    confidence: number
    internalNotes?: string
    note: string
  }
): Promise<void> {
  await createEscalation(supabase, {
    organization_id: params.orgId,
    conversation_id: params.conversationId,
    lead_id: params.leadId,
    reason: params.reason,
    ai_notes: params.internalNotes ? `${params.note} ${params.internalNotes}` : params.note,
    ai_confidence: params.confidence,
    agent_type: 'closer',
  }).catch(() => { /* escalation failure is non-fatal; the step still advances */ })
}

/** Advance the enrollment to the next step (or complete it). */
async function advance(
  supabase: SupabaseClient,
  campaign: Record<string, any>,
  enrollment: Enrollment,
  currentStepNumber: number,
  base: { enrollment_id: string; lead_id: string },
  detail: string
): Promise<ExecutionResult> {
  const { data: nextStep } = await supabase
    .from('campaign_steps')
    .select('delay_minutes')
    .eq('campaign_id', campaign.id)
    .eq('step_number', currentStepNumber + 1)
    .maybeSingle<{ delay_minutes: number | null }>()

  if (nextStep) {
    await supabase.from('campaign_enrollments').update({
      current_step: currentStepNumber,
      next_step_at: new Date(Date.now() + (nextStep.delay_minutes || 0) * 60 * 1000).toISOString(),
    }).eq('id', enrollment.id)
    return { ...base, action: detail === 'sent' ? 'sent' : 'skipped', detail }
  }

  return await completeEnrollment(supabase, campaign, enrollment, currentStepNumber, base, detail)
}

async function completeEnrollment(
  supabase: SupabaseClient,
  campaign: Record<string, any>,
  enrollment: Enrollment,
  currentStepNumber: number,
  base: { enrollment_id: string; lead_id: string },
  detail = 'completed'
): Promise<ExecutionResult> {
  await supabase.from('campaign_enrollments').update({
    current_step: currentStepNumber,
    status: 'completed',
    completed_at: new Date().toISOString(),
  }).eq('id', enrollment.id)
  await supabase.from('campaigns').update({
    total_completed: (campaign.total_completed || 0) + 1,
  }).eq('id', campaign.id)
  return { ...base, action: 'completed', detail }
}
