/**
 * Funnel Automation Executor
 *
 * Executes transition rules when a lead moves between pipeline stages.
 * Called by API routes that update lead stage_id (pipeline drag-drop, status updates).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getTransitionRules, type TransitionAction } from './automations'
import { processTemplate, buildTemplateContext, type TemplateContext } from '../campaigns/template'
import { decryptField } from '@/lib/encryption'
import { sendSMS } from '@/lib/messaging/twilio'
import { sendEmail } from '@/lib/messaging/resend'
import { scoreLead } from '@/lib/ai/scoring'
import { appendEmailFooter } from '@/lib/messaging/email-footer'
import { withRetry, RETRY_CONFIGS } from '@/lib/retry'

type AutomationResult = {
  ruleId: string
  actionsExecuted: number
  actionsDeferred: number
  errors: string[]
}

/**
 * Execute funnel automations for a stage transition.
 * Call this whenever a lead moves between pipeline stages.
 *
 * Immediate actions (delay_minutes = 0) run now.
 * Delayed actions are scheduled as campaign enrollments or tasks.
 */
export async function executeStageTransition(
  supabase: SupabaseClient,
  params: {
    organizationId: string
    leadId: string
    lead: Record<string, unknown>
    fromStageSlug: string | null
    toStageSlug: string
  }
): Promise<AutomationResult[]> {
  const rules = getTransitionRules(params.fromStageSlug, params.toStageSlug)
  if (rules.length === 0) return []

  const results: AutomationResult[] = []

  // Get org name for templates
  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', params.organizationId)
    .single()

  const templateCtx = buildTemplateContext(
    params.lead as any,
    org?.name || 'Our Practice',
    params.organizationId
  )

  for (const rule of rules) {
    // Check conditions
    if (rule.conditions && rule.conditions.length > 0) {
      const conditionsMet = rule.conditions.every((cond) => {
        const fieldValue = params.lead[cond.field]
        switch (cond.operator) {
          case 'equals': return fieldValue === cond.value
          case 'not_equals': return fieldValue !== cond.value
          case 'in': return Array.isArray(cond.value) && (cond.value as unknown[]).includes(fieldValue)
          case 'gt': return typeof fieldValue === 'number' && fieldValue > (cond.value as number)
          case 'lt': return typeof fieldValue === 'number' && fieldValue < (cond.value as number)
          case 'is_null': return fieldValue == null
          case 'not_null': return fieldValue != null
          default: return true
        }
      })
      if (!conditionsMet) continue
    }

    const result: AutomationResult = {
      ruleId: rule.id,
      actionsExecuted: 0,
      actionsDeferred: 0,
      errors: [],
    }

    for (const action of rule.actions) {
      if (action.delay_minutes === 0) {
        // Execute immediately
        try {
          await executeAction(supabase, action, params, templateCtx, org?.name || 'Our Practice')
          result.actionsExecuted++
        } catch (err) {
          result.errors.push(`${action.type}: ${err instanceof Error ? err.message : 'failed'}`)
        }
      } else {
        // Defer: log as a scheduled task for cron to pick up
        await supabase.from('lead_activities').insert({
          organization_id: params.organizationId,
          lead_id: params.leadId,
          activity_type: 'automation_scheduled',
          title: `Scheduled: ${action.type} (in ${action.delay_minutes}min)`,
          description: `Rule: ${rule.name}`,
          metadata: {
            rule_id: rule.id,
            action,
            execute_at: new Date(Date.now() + action.delay_minutes * 60 * 1000).toISOString(),
          },
        })
        result.actionsDeferred++
      }
    }

    results.push(result)
  }

  return results
}

async function executeAction(
  supabase: SupabaseClient,
  action: TransitionAction,
  params: {
    organizationId: string
    leadId: string
    lead: Record<string, unknown>
  },
  templateCtx: TemplateContext,
  orgName: string
): Promise<void> {
  switch (action.type) {
    case 'update_status': {
      const status = action.config.status as string
      await supabase
        .from('leads')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', params.leadId)
      break
    }

    case 'ai_score': {
      try {
        const scoreResult = await scoreLead(params.lead as any, supabase)
        await supabase
          .from('leads')
          .update({
            ai_score: scoreResult.total_score,
            ai_qualification: scoreResult.qualification,
            ai_score_breakdown: { dimensions: scoreResult.dimensions, confidence: scoreResult.confidence },
            ai_score_updated_at: new Date().toISOString(),
            ai_summary: scoreResult.summary,
          })
          .eq('id', params.leadId)
      } catch {
        // Non-blocking
      }
      break
    }

    case 'send_sms': {
      const phone = decryptField(params.lead.phone_formatted as string) || params.lead.phone_formatted as string
      if (!phone) break
      const template = action.config.template as string || ''
      const body = processTemplate(template, templateCtx)
      try {
        await withRetry(() => sendSMS(phone, body), RETRY_CONFIGS.twilio)
      } catch {
        // Log but don't fail the transition
      }
      break
    }

    case 'send_email': {
      const email = decryptField(params.lead.email as string) || params.lead.email as string
      if (!email) break
      const template = action.config.template as string || ''
      const subj = action.config.subject as string || `Update from ${orgName}`
      const body = processTemplate(template, templateCtx)
      const subject = processTemplate(subj, templateCtx)
      let html = `<div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">${body.replace(/\n/g, '<br>')}</div>`
      html = appendEmailFooter(html, { leadId: params.leadId, orgId: params.organizationId, orgName })
      try {
        await withRetry(() => sendEmail({ to: email, subject, html, text: body }), RETRY_CONFIGS.resend)
      } catch {
        // Non-blocking
      }
      break
    }

    case 'notify_team': {
      // Log as activity — in production would push to Slack/websocket
      await supabase.from('lead_activities').insert({
        organization_id: params.organizationId,
        lead_id: params.leadId,
        activity_type: 'team_notification',
        title: action.config.message as string || 'Team notification',
        metadata: { priority: action.config.priority },
      })
      break
    }

    case 'create_task': {
      const title = processTemplate(action.config.title as string || '', templateCtx)
      const description = processTemplate(action.config.description as string || '', templateCtx)
      await supabase.from('lead_activities').insert({
        organization_id: params.organizationId,
        lead_id: params.leadId,
        activity_type: 'task_created',
        title,
        description,
        metadata: {
          priority: action.config.priority,
          assign_to: action.config.assignTo,
        },
      })
      break
    }

    case 'enroll_campaign': {
      const campaignTemplate = action.config.campaign_template as string
      if (!campaignTemplate) break
      // Find matching active campaign
      const { data: campaign } = await supabase
        .from('campaigns')
        .select('id')
        .eq('organization_id', params.organizationId)
        .eq('status', 'active')
        .ilike('name', `%${campaignTemplate}%`)
        .limit(1)
        .single()

      if (campaign) {
        // Get first step delay
        const { data: firstStep } = await supabase
          .from('campaign_steps')
          .select('delay_minutes')
          .eq('campaign_id', campaign.id)
          .eq('step_number', 1)
          .single()

        const nextStepAt = new Date(Date.now() + (firstStep?.delay_minutes || 60) * 60 * 1000).toISOString()

        await supabase.from('campaign_enrollments').upsert({
          organization_id: params.organizationId,
          campaign_id: campaign.id,
          lead_id: params.leadId,
          status: 'active',
          current_step: 0,
          next_step_at: nextStepAt,
        }, { onConflict: 'campaign_id,lead_id', ignoreDuplicates: true })
      }
      break
    }

    case 'update_field': {
      const field = action.config.field as string
      const value = action.config.value
      if (field) {
        await supabase
          .from('leads')
          .update({ [field]: value, updated_at: new Date().toISOString() })
          .eq('id', params.leadId)
      }
      break
    }

    case 'schedule_followup': {
      const daysOut = action.config.days_out as number || 7
      const appointmentType = action.config.type as string || 'follow_up'
      await supabase.from('appointments').insert({
        organization_id: params.organizationId,
        lead_id: params.leadId,
        type: appointmentType,
        status: 'scheduled',
        scheduled_at: new Date(Date.now() + daysOut * 24 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 30,
      })
      break
    }

    default:
      break
  }
}
