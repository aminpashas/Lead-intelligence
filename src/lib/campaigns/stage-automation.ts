/**
 * Funnel Stage Automation
 *
 * When a lead moves to a new pipeline stage, this module:
 * 1. Executes entry actions from the funnel playbook (SMS, email, tasks, notifications)
 * 2. Enrolls the lead in matching trigger campaigns
 * 3. Exits campaigns from the old stage
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { FUNNEL_STAGES, type StageAction } from '@/lib/funnel/stages'
import { processTriggerCampaigns, type TriggerEvent } from './triggers'
import { exitAllCampaigns } from './enrollments'
import { processTemplate, buildTemplateContext, type TemplateContext } from './template'
import { sendSMS } from '@/lib/messaging/twilio'
import { sendEmail } from '@/lib/messaging/resend'
import { decryptField } from '@/lib/encryption'

type StageChangeResult = {
  entryActionsExecuted: number
  campaignsTriggered: number
  campaignsExited: number
  errors: string[]
}

/**
 * Called when a lead's pipeline stage changes.
 */
export async function onStageChange(
  supabase: SupabaseClient,
  leadId: string,
  oldStage: string,
  newStage: string,
  organizationId: string
): Promise<StageChangeResult> {
  const result: StageChangeResult = {
    entryActionsExecuted: 0,
    campaignsTriggered: 0,
    campaignsExited: 0,
    errors: [],
  }

  // Exit campaigns if lead is lost/disqualified
  if (newStage === 'lost' || newStage === 'disqualified') {
    result.campaignsExited = await exitAllCampaigns(
      supabase,
      leadId,
      `Lead moved to ${newStage}`
    )
  }

  // Get the stage definition
  const stageConfig = FUNNEL_STAGES.find((s) => s.slug === newStage)

  // Execute entry actions
  if (stageConfig?.entryActions) {
    const { data: lead } = await supabase
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single()

    if (lead) {
      // Decrypt PII for sending
      const decryptedLead = { ...lead }
      decryptedLead.phone_formatted = decryptField(lead.phone_formatted) || lead.phone_formatted
      decryptedLead.phone = decryptField(lead.phone) || lead.phone
      decryptedLead.email = decryptField(lead.email) || lead.email

      const { data: org } = await supabase
        .from('organizations')
        .select('name')
        .eq('id', organizationId)
        .single()

      const orgName = org?.name || 'Our Practice'
      const templateCtx = buildTemplateContext(decryptedLead, orgName, organizationId)

      for (const action of stageConfig.entryActions) {
        try {
          await executeEntryAction(supabase, action, decryptedLead, organizationId, templateCtx, orgName)
          result.entryActionsExecuted++
        } catch (err) {
          result.errors.push(`Entry action '${action.type}': ${err instanceof Error ? err.message : 'unknown'}`)
        }
      }
    }
  }

  // Fire trigger campaigns for stage_changed event
  try {
    const triggered = await processTriggerCampaigns(supabase, {
      event: 'stage_changed' as TriggerEvent,
      lead_id: leadId,
      organization_id: organizationId,
      metadata: { old_stage: oldStage, new_stage: newStage },
    })
    result.campaignsTriggered = triggered
  } catch (err) {
    result.errors.push(`Trigger campaigns: ${err instanceof Error ? err.message : 'unknown'}`)
  }

  // Log the stage change activity
  await supabase.from('lead_activities').insert({
    organization_id: organizationId,
    lead_id: leadId,
    activity_type: 'stage_changed',
    title: `Stage changed: ${oldStage} → ${newStage}`,
    description: `${result.entryActionsExecuted} entry actions, ${result.campaignsTriggered} campaigns triggered`,
  })

  return result
}

async function executeEntryAction(
  supabase: SupabaseClient,
  action: StageAction,
  lead: Record<string, unknown>,
  organizationId: string,
  templateCtx: TemplateContext,
  orgName: string
): Promise<void> {
  // Skip delayed actions (those are handled by the campaign system)
  // Only execute immediate actions (delay_minutes <= 2)
  if (action.delay_minutes > 2) return

  switch (action.type) {
    case 'sms': {
      if (!action.template || !lead.phone_formatted) return
      if (lead.sms_opt_out || !lead.sms_consent) return
      const message = processTemplate(action.template, templateCtx)
      await sendSMS(lead.phone_formatted as string, message)

      // Store as message
      const { data: convo } = await supabase
        .from('conversations')
        .select('id')
        .eq('lead_id', lead.id)
        .eq('channel', 'sms')
        .eq('status', 'active')
        .limit(1)
        .single()

      if (convo) {
        await supabase.from('messages').insert({
          organization_id: organizationId,
          conversation_id: convo.id,
          lead_id: lead.id,
          direction: 'outbound',
          channel: 'sms',
          body: message,
          sender_type: 'system',
          status: 'sent',
          metadata: { source: 'stage_entry_action' },
        })
      }
      break
    }

    case 'email': {
      if (!action.template || !lead.email) return
      if (lead.email_opt_out || !lead.email_consent) return
      const emailBody = processTemplate(action.template, templateCtx)
      await sendEmail({
        to: lead.email as string,
        subject: `Update from ${orgName}`,
        html: `<div style="font-family: -apple-system, sans-serif; padding: 24px;">${emailBody.replace(/\n/g, '<br>')}</div>`,
        text: emailBody,
      })
      break
    }

    case 'notification': {
      // Create an internal notification/task
      await supabase.from('lead_activities').insert({
        organization_id: organizationId,
        lead_id: lead.id as string,
        activity_type: 'notification',
        title: action.description,
        metadata: { assign_to: action.assignTo },
      })
      break
    }

    case 'task': {
      await supabase.from('lead_activities').insert({
        organization_id: organizationId,
        lead_id: lead.id as string,
        activity_type: 'task_created',
        title: action.description,
        metadata: { assign_to: action.assignTo, due_minutes: action.delay_minutes },
      })
      break
    }

    case 'ai_score': {
      // AI scoring is handled separately via the scoring endpoint
      // Just log that it should happen
      await supabase.from('lead_activities').insert({
        organization_id: organizationId,
        lead_id: lead.id as string,
        activity_type: 'ai_score_requested',
        title: 'AI scoring triggered by stage entry',
      })
      break
    }
  }
}
