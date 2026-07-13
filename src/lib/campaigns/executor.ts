import type { SupabaseClient } from '@supabase/supabase-js'
import { processTemplate, buildTemplateContext } from './template'
import { checkSendWindow } from './send-window'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { sendEmail } from '@/lib/messaging/resend'
import { generateLeadEngagement } from '@/lib/ai/scoring'
import { appendEmailFooter } from '@/lib/messaging/email-footer'
import { emailCampaignGate, logUnconsentedEmailSend } from '@/lib/consent/gate'
import { withRetry, RETRY_CONFIGS } from '@/lib/retry'
import { decryptField } from '@/lib/encryption'
import { POST_CONSULT_NURTURE_KEY } from './post-consult-nurture'
import { executeNurtureStep } from './nurture-executor'
import { checkCompliance } from '@/lib/ai/compliance-filter'
import { createEscalation } from '@/lib/autopilot/escalation'
import { resolveAutomationOwner } from '@/lib/automation/allocation'
import { enqueueCampaignReviewDraft } from '@/lib/campaigns/review-drafts'

export type ExecutionResult = {
  enrollment_id: string
  lead_id: string
  action: 'sent' | 'deferred' | 'exited' | 'completed' | 'skipped' | 'error'
  detail?: string
}

/**
 * Execute all due campaign steps for an organization.
 */
export async function executeCampaignSteps(
  supabase: SupabaseClient,
  organizationId: string
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = []

  // Get all due enrollments
  const { data: dueEnrollments } = await supabase
    .from('campaign_enrollments')
    .select(`
      *,
      campaign:campaigns(*),
      lead:leads(*)
    `)
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .lte('next_step_at', new Date().toISOString())
    .limit(50) // Process 50 at a time to avoid timeouts

  if (!dueEnrollments || dueEnrollments.length === 0) return results

  for (const enrollment of dueEnrollments) {
    try {
      const result = await executeOneStep(supabase, enrollment)
      results.push(result)
    } catch (err) {
      results.push({
        enrollment_id: enrollment.id,
        lead_id: enrollment.lead_id,
        action: 'error',
        detail: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  return results
}

async function executeOneStep(
  supabase: SupabaseClient,
  enrollment: any
): Promise<ExecutionResult> {
  const { campaign } = enrollment
  const lead = enrollment.lead ? { ...enrollment.lead } : null
  if (!campaign || !lead) {
    return { enrollment_id: enrollment.id, lead_id: enrollment.lead_id, action: 'error', detail: 'Missing campaign or lead' }
  }

  // The post-consult funding nurture has its own objection-aware, autopilot-gated
  // send path (closer composition, financing-aware skips, co-signer link).
  if (campaign.metadata?.system_key === POST_CONSULT_NURTURE_KEY) {
    return executeNurtureStep(supabase, enrollment)
  }

  // Decrypt PII fields for sending
  lead.phone_formatted = decryptField(lead.phone_formatted) || lead.phone_formatted
  lead.phone = decryptField(lead.phone) || lead.phone
  lead.email = decryptField(lead.email) || lead.email

  // Idempotency: Atomically claim this execution by setting next_step_at far in the future.
  // If another cron already claimed it, this update won't match (0 rows updated).
  const nextStepNumber = (enrollment.current_step || 0) + 1
  const idempotencyLock = new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 min lock
  const { data: claimed } = await supabase
    .from('campaign_enrollments')
    .update({ next_step_at: idempotencyLock })
    .eq('id', enrollment.id)
    .eq('current_step', enrollment.current_step) // Only if step hasn't changed
    .lte('next_step_at', new Date().toISOString()) // Only if still due
    .select('id')
    .single()

  if (!claimed) {
    // Another process already claimed this enrollment
    return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'skipped', detail: 'Already being processed (idempotency)' }
  }

  // Get the current step
  const { data: step } = await supabase
    .from('campaign_steps')
    .select('*')
    .eq('campaign_id', campaign.id)
    .eq('step_number', nextStepNumber)
    .single()

  if (!step) {
    // No more steps — mark completed
    await supabase.from('campaign_enrollments').update({
      status: 'completed',
      completed_at: new Date().toISOString(),
    }).eq('id', enrollment.id)

    await supabase.from('campaigns').update({
      total_completed: (campaign.total_completed || 0) + 1,
    }).eq('id', campaign.id)

    return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'completed' }
  }

  // Check exit conditions
  if (step.exit_condition) {
    const shouldExit = evaluateExitCondition(step.exit_condition, lead, enrollment)
    if (shouldExit) {
      await supabase.from('campaign_enrollments').update({
        status: 'exited',
        exited_at: new Date().toISOString(),
        exit_reason: 'Exit condition met',
      }).eq('id', enrollment.id)

      return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'exited', detail: 'Exit condition met' }
    }
  }

  // Check send conditions
  if (step.send_condition) {
    const canSend = evaluateSendCondition(step.send_condition, lead, enrollment)
    if (!canSend) {
      // Defer by 1 hour and check again later
      await supabase.from('campaign_enrollments').update({
        next_step_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }).eq('id', enrollment.id)

      return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'skipped', detail: 'Send condition not met' }
    }
  }

  // Check send window
  const windowCheck = checkSendWindow(campaign.send_window)
  if (!windowCheck.allowed) {
    await supabase.from('campaign_enrollments').update({
      next_step_at: windowCheck.nextValidTime?.toISOString(),
    }).eq('id', enrollment.id)

    return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'deferred', detail: 'Outside send window' }
  }

  // Get organization name
  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', campaign.organization_id)
    .single()

  // Process template
  const ctx = buildTemplateContext(lead, org?.name || 'Our Practice', campaign.organization_id)
  let messageBody = processTemplate(step.body_template, ctx)
  let subject = step.subject ? processTemplate(step.subject, ctx) : undefined

  // AI Personalization
  if (step.ai_personalize) {
    try {
      const mode = step.step_number <= 2 ? 'education' : step.step_number <= 4 ? 'objection_handling' : 'appointment_scheduling'
      const aiResult = await generateLeadEngagement(lead, [], {
        mode: mode as any,
        channel: step.channel,
      }, supabase)
      messageBody = aiResult.message
    } catch {
      // Fall back to template if AI fails
    }
  }

  // TCPA/CAN-SPAM: Verify consent before sending
  if (step.channel === 'sms' && (!lead.sms_consent || lead.sms_opt_out)) {
    await supabase.from('campaign_enrollments').update({
      status: 'exited',
      exited_at: new Date().toISOString(),
      exit_reason: 'No SMS consent or opted out',
    }).eq('id', enrollment.id)
    return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'exited', detail: 'No SMS consent' }
  }
  // Email may pass without prior consent ONLY on a campaign explicitly flagged
  // allow_unconsented_email (re-permission); opt-out/declined never pass.
  const emailGate = emailCampaignGate(lead, {
    allowUnconsented: campaign.allow_unconsented_email === true,
  })
  if (step.channel === 'email' && !emailGate.allowed) {
    await supabase.from('campaign_enrollments').update({
      status: 'exited',
      exited_at: new Date().toISOString(),
      exit_reason: `No email consent or opted out (${emailGate.reason})`,
    }).eq('id', enrollment.id)
    return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'exited', detail: 'No email consent' }
  }

  // Content compliance for fixed-template + AI campaign copy. The per-send filter
  // inside sendSMSToLead only runs for aiGenerated content, and the email path
  // here calls sendEmail() directly (bypassing sendEmailToLead's gate), so
  // template copy would otherwise reach patients unscreened. We hard-block only
  // (allowed === false): false approval claims, PII, profanity, forbidden medical
  // claims. Soft-review items (pricing, coverage) still send so live "$X/mo"
  // campaigns are unaffected. Voice steps carry no patient-facing body here.
  if (step.channel === 'sms' || step.channel === 'email') {
    const compliance = checkCompliance(messageBody, { channel: step.channel })
    if (!compliance.allowed) {
      await supabase.from('campaign_enrollments').update({
        status: 'exited',
        exited_at: new Date().toISOString(),
        exit_reason: `Compliance blocked: ${compliance.reasons.join(', ')}`,
      }).eq('id', enrollment.id)
      await supabase.from('events').insert({
        organization_id: campaign.organization_id,
        lead_id: lead.id,
        event_type: 'compliance_block',
        payload: {
          channel: step.channel,
          caller: `campaign.executor:${campaign.name}:step_${step.step_number}`,
          reasons: compliance.reasons,
          body_preview: messageBody.slice(0, 200),
        },
        capi_status: 'na',
        gads_status: 'na',
      }).then(() => undefined, () => undefined)
      return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'exited', detail: `compliance_blocked: ${compliance.reasons.join(', ')}` }
    }
  }

  // Allocation policy gate (Workstream D1, dormant by default): applies to
  // AI-generated steps only — fixed templates keep today's behavior. A step
  // allocated to a human (or human-first hold) routes the draft through the
  // existing escalation path instead of sending, then advances the enrollment
  // (same semantics as the nurture executor's shadow/low-confidence path).
  // With zero policy rows this always resolves to 'ai' (legacy path).
  if (step.ai_personalize && (step.channel === 'sms' || step.channel === 'email')) {
    const allocation = await resolveAutomationOwner(supabase, {
      organizationId: campaign.organization_id,
      kind: 'nurture_step',
      campaignId: campaign.id,
    })
    if (allocation.owner !== 'ai') {
      // TODO(D2/D3 wiring point): create the human task + SLA timer for 'hold'.
      const conversationIdForDraft = await findOrCreateConversation(
        supabase, campaign.organization_id, lead.id, step.channel, subject
      )
      if (conversationIdForDraft) {
        await createEscalation(supabase, {
          organization_id: campaign.organization_id,
          conversation_id: conversationIdForDraft,
          lead_id: lead.id,
          reason: 'compliance_flag',
          ai_notes: `Allocated to human by automation policy (allocated_to_human: ${allocation.reason}) — campaign draft not auto-sent.`,
          ai_draft_response: messageBody,
        }).catch(() => { /* escalation failure is non-fatal; the step still advances */ })
      }
      await advanceEnrollment(supabase, campaign, enrollment, nextStepNumber)
      return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'skipped', detail: `allocated_to_human: ${allocation.reason}` }
    }
  }

  // review_first campaign mode: don't auto-send — queue the composed touch for
  // human approval and advance the enrollment (same "draft it and move on"
  // semantics as the allocation-to-human path above). Only SMS/email are
  // reviewable here; voice steps place calls and have no reviewable body.
  if (campaign.autopilot_mode === 'review_first' && (step.channel === 'sms' || step.channel === 'email')) {
    await enqueueCampaignReviewDraft(supabase, {
      organizationId: campaign.organization_id,
      campaignId: campaign.id,
      leadId: lead.id,
      conversationId: null,
      channel: step.channel,
      subject: step.channel === 'email' ? (subject ?? null) : null,
      body: messageBody,
    })
    await advanceEnrollment(supabase, campaign, enrollment, nextStepNumber)
    return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'skipped', detail: 'queued_for_review' }
  }

  // Send the message
  let externalId: string | null = null
  let sendSuccess = false

  if (step.channel === 'sms') {
    if (!lead.phone_formatted) {
      return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'error', detail: 'No phone number' }
    }
    try {
      const sendRes = await withRetry(
        () => sendSMSToLead({
          supabase, leadId: lead.id, to: lead.phone_formatted, body: messageBody, caller: 'campaign.executor',
        }),
        RETRY_CONFIGS.twilio
      )
      if (!sendRes.sent) {
        await supabase.from('campaign_enrollments').update({
          status: 'exited',
          exited_at: new Date().toISOString(),
          exit_reason: `No SMS consent or opted out (${sendRes.reason})`,
        }).eq('id', enrollment.id)
        return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'exited', detail: `SMS blocked: ${sendRes.reason}` }
      }
      externalId = sendRes.sid
      sendSuccess = true
    } catch (err) {
      return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'error', detail: `SMS failed: ${err instanceof Error ? err.message : 'unknown'}` }
    }
  } else if (step.channel === 'voice') {
    // Outbound Retell call (Day 10 of the seeded Reactivation campaign uses this).
    // Consent + DNC enforced inside placeOutboundCallToLead.
    const { placeOutboundCallToLead } = await import('@/lib/voice/outbound-to-lead')
    const result = await placeOutboundCallToLead({
      supabase,
      leadId: lead.id,
      organizationId: campaign.organization_id,
      caller: `campaign:${campaign.name}:step_${step.step_number}`,
      dynamicVariables: { practice_name: org?.name || 'our practice' },
    })
    if (!result.placed) {
      // No-consent / DNC are exits, not retries. Other failures are errors so cron retries.
      const isExit = result.reason === 'no_consent' || result.reason === 'opted_out' || result.reason === 'do_not_call'
      if (isExit) {
        await supabase.from('campaign_enrollments').update({
          status: 'exited',
          exited_at: new Date().toISOString(),
          exit_reason: `Voice ${result.reason}`,
        }).eq('id', enrollment.id)
        return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'exited', detail: `voice_${result.reason}` }
      }
      return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'error', detail: `voice_${result.reason}${result.detail ? ': ' + result.detail : ''}` }
    }
    externalId = result.call.call_id || null
    sendSuccess = true
  } else if (step.channel === 'email') {
    if (!lead.email) {
      return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'error', detail: 'No email' }
    }
    try {
      const orgName = org?.name || 'Our Practice'
      let htmlBody = `<div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        ${messageBody.replace(/\n/g, '<br>')}
        <br><br>
        <p style="color: #888; font-size: 12px;">
          ${orgName}<br>
          <a href="${process.env.NEXT_PUBLIC_APP_URL}/qualify/${campaign.organization_id}" style="color: #d97706;">Schedule Your Free Consultation</a>
        </p>
      </div>`

      // CAN-SPAM: Append unsubscribe footer to all campaign emails
      htmlBody = appendEmailFooter(htmlBody, {
        leadId: lead.id,
        orgId: campaign.organization_id,
        orgName,
      })

      const result = await withRetry(
        () => sendEmail({
          to: lead.email,
          subject: subject || `A message from ${orgName}`,
          html: htmlBody,
          text: messageBody,
        }),
        RETRY_CONFIGS.resend
      )
      externalId = result.id
      sendSuccess = true
      if (emailGate.allowed && emailGate.usedOverride) {
        await logUnconsentedEmailSend(supabase, {
          organizationId: campaign.organization_id,
          leadId: lead.id,
          campaignId: campaign.id,
          caller: 'campaign.executor',
        })
      }
    } catch (err) {
      return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'error', detail: `Email failed: ${err instanceof Error ? err.message : 'unknown'}` }
    }
  }

  if (!sendSuccess) {
    return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'error', detail: 'Send failed' }
  }

  // Find or create conversation
  let conversationId: string | null = null
  const { data: existingConvo } = await supabase
    .from('conversations')
    .select('id')
    .eq('lead_id', lead.id)
    .eq('channel', step.channel)
    .eq('status', 'active')
    .limit(1)
    .single()

  if (existingConvo) {
    conversationId = existingConvo.id
  } else {
    const { data: newConvo } = await supabase
      .from('conversations')
      .insert({
        organization_id: campaign.organization_id,
        lead_id: lead.id,
        channel: step.channel,
        status: 'active',
        ai_enabled: true,
        ai_mode: 'auto',
        subject: subject,
      })
      .select('id')
      .single()
    conversationId = newConvo?.id || null
  }

  // Store message
  if (conversationId) {
    await supabase.from('messages').insert({
      organization_id: campaign.organization_id,
      conversation_id: conversationId,
      lead_id: lead.id,
      direction: 'outbound',
      channel: step.channel,
      body: messageBody,
      subject,
      sender_type: step.ai_personalize ? 'ai' : 'system',
      status: 'sent',
      external_id: externalId,
      ai_generated: step.ai_personalize,
      metadata: { campaign_id: campaign.id, step_number: step.step_number },
    })
  }

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: campaign.organization_id,
    lead_id: lead.id,
    activity_type: step.channel === 'sms' ? 'sms_sent' : 'email_sent',
    title: `Campaign "${campaign.name}" — Step ${step.step_number}`,
    description: messageBody.substring(0, 200),
    metadata: { campaign_id: campaign.id, step_number: step.step_number },
  })

  // Update step stats
  await supabase.from('campaign_steps').update({
    total_sent: (step.total_sent || 0) + 1,
  }).eq('id', step.id)

  // Calculate next step time
  const { data: nextStep } = await supabase
    .from('campaign_steps')
    .select('delay_minutes')
    .eq('campaign_id', campaign.id)
    .eq('step_number', nextStepNumber + 1)
    .single()

  if (nextStep) {
    // More steps — schedule next one
    const nextTime = new Date(Date.now() + (nextStep.delay_minutes || 0) * 60 * 1000)
    await supabase.from('campaign_enrollments').update({
      current_step: nextStepNumber,
      next_step_at: nextTime.toISOString(),
    }).eq('id', enrollment.id)
  } else {
    // Last step — mark completed
    await supabase.from('campaign_enrollments').update({
      current_step: nextStepNumber,
      status: 'completed',
      completed_at: new Date().toISOString(),
    }).eq('id', enrollment.id)

    await supabase.from('campaigns').update({
      total_completed: (campaign.total_completed || 0) + 1,
    }).eq('id', campaign.id)
  }

  return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'sent', detail: `${step.channel} step ${step.step_number}` }
}

// ── Helpers ───────────────────────────────────────

/**
 * Find the lead's active conversation on a channel, or create one.
 * Same lookup/insert the post-send path uses; needed earlier by the
 * allocation gate so the escalated draft has a thread to attach to.
 */
async function findOrCreateConversation(
  supabase: SupabaseClient,
  organizationId: string,
  leadId: string,
  channel: string,
  subject?: string
): Promise<string | null> {
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
    .insert({
      organization_id: organizationId,
      lead_id: leadId,
      channel,
      status: 'active',
      ai_enabled: true,
      ai_mode: 'auto',
      subject,
    })
    .select('id')
    .single<{ id: string }>()
  return created?.id || null
}

/**
 * Advance the enrollment to the next step (or complete it) without sending.
 * Mirrors the post-send scheduling block.
 */
async function advanceEnrollment(
  supabase: SupabaseClient,
  campaign: { id: string; total_completed?: number | null },
  enrollment: { id: string },
  currentStepNumber: number
): Promise<void> {
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
  } else {
    await supabase.from('campaign_enrollments').update({
      current_step: currentStepNumber,
      status: 'completed',
      completed_at: new Date().toISOString(),
    }).eq('id', enrollment.id)
    await supabase.from('campaigns').update({
      total_completed: (campaign.total_completed || 0) + 1,
    }).eq('id', campaign.id)
  }
}

// ── Condition Evaluators ──────────────────────────

function evaluateExitCondition(
  condition: Record<string, unknown>,
  lead: any,
  enrollment: any
): boolean {
  // Exit if lead replied
  if (condition.if_replied && lead.total_messages_received > 0 && lead.last_responded_at) {
    const enrolledAt = new Date(enrollment.created_at).getTime()
    const respondedAt = new Date(lead.last_responded_at).getTime()
    if (respondedAt > enrolledAt) return true
  }

  // Exit if lead reached certain statuses
  if (condition.if_status_in && Array.isArray(condition.if_status_in)) {
    if ((condition.if_status_in as string[]).includes(lead.status)) return true
  }

  // Exit if lead scored above threshold
  if (typeof condition.if_score_above === 'number') {
    if (lead.ai_score > (condition.if_score_above as number)) return true
  }

  // Exit if appointment scheduled
  if (condition.if_appointment_scheduled && lead.consultation_date) return true

  return false
}

function evaluateSendCondition(
  condition: Record<string, unknown>,
  lead: any,
  enrollment: any
): boolean {
  // Only send if no reply within X hours
  if (typeof condition.if_no_reply_within === 'number') {
    const hours = condition.if_no_reply_within as number
    if (lead.last_responded_at) {
      const hoursSinceReply = (Date.now() - new Date(lead.last_responded_at).getTime()) / (1000 * 60 * 60)
      if (hoursSinceReply < hours) return false // They replied recently, skip
    }
  }

  // Only send if score is in range
  if (typeof condition.if_score_above === 'number') {
    if (lead.ai_score < (condition.if_score_above as number)) return false
  }
  if (typeof condition.if_score_below === 'number') {
    if (lead.ai_score > (condition.if_score_below as number)) return false
  }

  return true
}
