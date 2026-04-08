import type { SupabaseClient } from '@supabase/supabase-js'
import { processTemplate, buildTemplateContext } from './template'
import { checkSendWindow } from './send-window'
import { sendSMS } from '@/lib/messaging/twilio'
import { sendEmail } from '@/lib/messaging/resend'
import { generateLeadEngagement } from '@/lib/ai/scoring'

type ExecutionResult = {
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
  const { campaign, lead } = enrollment
  if (!campaign || !lead) {
    return { enrollment_id: enrollment.id, lead_id: enrollment.lead_id, action: 'error', detail: 'Missing campaign or lead' }
  }

  // Get the current step
  const nextStepNumber = (enrollment.current_step || 0) + 1
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
      })
      messageBody = aiResult.message
    } catch {
      // Fall back to template if AI fails
    }
  }

  // Send the message
  let externalId: string | null = null
  let sendSuccess = false

  if (step.channel === 'sms') {
    if (!lead.phone_formatted) {
      return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'error', detail: 'No phone number' }
    }
    try {
      const result = await sendSMS(lead.phone_formatted, messageBody)
      externalId = result.sid
      sendSuccess = true
    } catch (err) {
      return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'error', detail: `SMS failed: ${err instanceof Error ? err.message : 'unknown'}` }
    }
  } else if (step.channel === 'email') {
    if (!lead.email) {
      return { enrollment_id: enrollment.id, lead_id: lead.id, action: 'error', detail: 'No email' }
    }
    try {
      const htmlBody = `<div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        ${messageBody.replace(/\n/g, '<br>')}
        <br><br>
        <p style="color: #888; font-size: 12px;">
          ${org?.name || 'Our Practice'}<br>
          <a href="${process.env.NEXT_PUBLIC_APP_URL}/qualify/${campaign.organization_id}" style="color: #d97706;">Schedule Your Free Consultation</a>
        </p>
      </div>`
      const result = await sendEmail({
        to: lead.email,
        subject: subject || `A message from ${org?.name || 'us'}`,
        html: htmlBody,
        text: messageBody,
      })
      externalId = result.id
      sendSuccess = true
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
