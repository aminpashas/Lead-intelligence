/**
 * DB-driven appointment sequence executor.
 *
 * When an org's `appointment_prep` outreach sequence is ENABLED, this replaces
 * the legacy hardcoded 72h/24h/2h/1h reminder pipeline: each enabled step
 * (offset relative to the appointment time, channel, AI/human owner,
 * confirmed/unconfirmed condition) is evaluated every cron pass.
 *
 * Dedupe: one `appointment_reminders` row per (appointment, step) with
 * reminder_type = 'seq:<step.id>'. Steps carrying metadata.legacy also stamp
 * the legacy reminder_sent_* booleans so flipping back to the legacy executor
 * never double-sends.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { SequenceWithSteps } from './sequences'
import { executeSequenceStep } from './sequences'
import { dueAppointmentSteps, executableSteps } from './sequence-schedule'
import type { OutreachSequenceStep } from '@/types/database'
import {
  generate72hEmailTemplate,
  generate24hEmailTemplate,
  generate24hSmsTemplate,
  generate1hSmsTemplate,
  getConfirmationUrl,
  getRescheduleUrl,
} from '@/lib/campaigns/reminder-templates'
import { formatAppointmentDateTime, type ReminderResult } from '@/lib/campaigns/reminders'
import { initiateConfirmationCall } from '@/lib/campaigns/confirmation-call'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { sendEmail } from '@/lib/messaging/resend'
import { decryptLeadPII } from '@/lib/encryption'
import { logger } from '@/lib/logger'

const MINUTE = 60 * 1000

type AppointmentRow = {
  id: string
  organization_id: string
  lead_id: string
  type: string
  status: string
  scheduled_at: string
  location: string | null
  confirmation_received: boolean
  lead: Record<string, unknown> | null
}

const LEGACY_FLAG_BY_TAG: Record<string, string> = {
  '72h': 'reminder_sent_72h',
  '24h_sms': 'reminder_sent_24h',
  '24h_email': 'reminder_sent_24h',
  '2h_call': 'reminder_sent_2h',
  '1h_sms': 'reminder_sent_1h',
}

export async function runAppointmentSequence(
  supabase: SupabaseClient,
  orgId: string,
  sequence: SequenceWithSteps
): Promise<ReminderResult[]> {
  const results: ReminderResult[] = []
  const nowMs = Date.now()
  const steps = executableSteps(sequence.steps)
  if (steps.length === 0) return results

  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .single()
  const practiceName = org?.name || 'our office'

  // Look ahead far enough to cover the earliest (most negative) step.
  const maxAheadMs =
    Math.max(0, ...steps.map((s) => -s.offset_minutes)) * MINUTE + 6 * 60 * MINUTE

  const { data: appointments } = await supabase
    .from('appointments')
    .select(
      `id, organization_id, lead_id, type, status, scheduled_at, location, confirmation_received,
       lead:leads (id, first_name, last_name, phone, phone_formatted, email,
         voice_consent, voice_opt_out, do_not_call, sms_consent, sms_opt_out,
         email_consent, email_opt_out, status)`
    )
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed'])
    .gte('scheduled_at', new Date(nowMs).toISOString())
    .lte('scheduled_at', new Date(nowMs + maxAheadMs).toISOString())

  for (const apt of (appointments || []) as unknown as AppointmentRow[]) {
    const confirmed = apt.confirmation_received || apt.status === 'confirmed'
    const due = dueAppointmentSteps(steps, apt.scheduled_at, { nowMs, confirmed })
    if (due.length === 0) continue

    for (const step of due) {
      const stepTag = `seq:${step.id}`
      // Per-(appointment, step) dedupe.
      const { data: already } = await supabase
        .from('appointment_reminders')
        .select('id')
        .eq('appointment_id', apt.id)
        .eq('reminder_type', stepTag)
        .limit(1)
        .maybeSingle()
      if (already) continue

      try {
        const r = await executeAppointmentStep(supabase, {
          orgId,
          practiceName,
          apt,
          step: step as OutreachSequenceStep,
        })
        await recordStepOutcome(supabase, orgId, apt, step as OutreachSequenceStep, stepTag, r)
        results.push({
          appointment_id: apt.id,
          type: '24h', // ReminderResult.type is a legacy enum; detail carries the step
          channel: step.channel === 'email' ? 'email' : step.channel === 'ai_call' ? 'voice_confirmation' : 'sms',
          status: r.status === 'error' ? 'error' : r.status,
          detail: `${stepTag}${r.detail ? `: ${r.detail}` : ''}`,
        })
      } catch (err) {
        logger.error(
          'Appointment sequence step failed',
          { appointmentId: apt.id, stepId: step.id },
          err instanceof Error ? err : undefined
        )
        results.push({
          appointment_id: apt.id,
          type: '24h',
          channel: step.channel === 'email' ? 'email' : 'sms',
          status: 'error',
          detail: `${stepTag}: ${err instanceof Error ? err.message : 'unknown'}`,
        })
      }
    }
  }

  return results
}

type StepOutcome = { status: 'sent' | 'skipped' | 'error'; detail?: string; externalId?: string }

async function executeAppointmentStep(
  supabase: SupabaseClient,
  params: {
    orgId: string
    practiceName: string
    apt: AppointmentRow
    step: OutreachSequenceStep
  }
): Promise<StepOutcome> {
  const { orgId, practiceName, apt, step } = params
  if (!apt.lead) return { status: 'skipped', detail: 'no_lead' }
  const lead = decryptLeadPII(apt.lead as never) as Record<string, unknown>
  const firstName = (lead.first_name as string) || 'there'
  const dateTime = formatAppointmentDateTime(apt.scheduled_at)
  const legacyTag = (step.metadata?.legacy as string) || null

  // Human-owned steps (any channel) → tasks queue via the shared engine.
  if (step.owner === 'human' || step.channel === 'human_call' || step.channel === 'human_task') {
    const r = await executeSequenceStep(supabase, {
      organizationId: orgId,
      lead: apt.lead, // encrypted row; engine decrypts what it needs
      step,
      scopeId: apt.id,
      source: 'appointment_sequence',
    })
    return { status: r.status === 'task_created' ? 'sent' : 'skipped', detail: r.detail }
  }

  if (step.channel === 'ai_call') {
    // Confirmation-style AI call; compliance-gated inside (preCallCheck).
    const call = await initiateConfirmationCall(supabase, {
      organization_id: orgId,
      appointment_id: apt.id,
      lead_id: apt.lead_id,
      lead_first_name: firstName,
      appointment_type: apt.type,
      appointment_datetime: apt.scheduled_at,
      practice_name: practiceName,
    })
    if (call.status === 'initiated') return { status: 'sent', externalId: call.retell_call_id }
    return { status: call.status === 'failed' ? 'error' : 'skipped', detail: call.reason }
  }

  const confirmUrl = getConfirmationUrl(apt.id, orgId)
  const rescheduleUrl = getRescheduleUrl(apt.id, orgId)

  if (step.channel === 'sms') {
    // Same consent semantics as the legacy 24h SMS.
    if (!lead.phone || lead.sms_opt_out || !lead.sms_consent) {
      return { status: 'skipped', detail: 'no_phone_or_no_consent' }
    }
    const body =
      step.template_body?.replace(/\{first(_name)?\}/g, firstName) ??
      (legacyTag === '1h_sms'
        ? generate1hSmsTemplate({ firstName, appointmentTime: dateTime, practiceName })
        : generate24hSmsTemplate({ firstName, appointmentType: apt.type, dateTime, practiceName }))
    const sendRes = await sendSMSToLead({
      supabase,
      leadId: apt.lead_id,
      to: lead.phone as string,
      body,
      caller: 'appointment_sequence',
    })
    if (!sendRes.sent) return { status: 'skipped', detail: sendRes.reason }
    return { status: 'sent', externalId: sendRes.sid }
  }

  // Email — legacy semantics: email present and not opted out.
  if (!lead.email || lead.email_opt_out) {
    return { status: 'skipped', detail: 'no_email_or_opted_out' }
  }
  const tpl =
    legacyTag === '72h'
      ? generate72hEmailTemplate({ firstName, appointmentType: apt.type, dateTime, location: apt.location, practiceName, confirmUrl, rescheduleUrl })
      : generate24hEmailTemplate({ firstName, appointmentType: apt.type, dateTime, location: apt.location, practiceName, confirmUrl, rescheduleUrl })
  const subject = step.template_subject || tpl.subject
  const body = step.template_body?.replace(/\{first(_name)?\}/g, firstName)
  const result = await sendEmail({
    to: lead.email as string,
    subject,
    html: body ? `<div style="font-family: -apple-system, sans-serif; padding: 24px;">${body.replace(/\n/g, '<br>')}</div>` : tpl.html,
    text: body || tpl.text,
  })
  return { status: 'sent', externalId: result.id }
}

async function recordStepOutcome(
  supabase: SupabaseClient,
  orgId: string,
  apt: AppointmentRow,
  step: OutreachSequenceStep,
  stepTag: string,
  outcome: StepOutcome
) {
  await supabase.from('appointment_reminders').insert({
    organization_id: orgId,
    appointment_id: apt.id,
    lead_id: apt.lead_id,
    channel: step.channel === 'ai_call' ? 'voice_confirmation' : step.channel === 'email' ? 'email' : 'sms',
    reminder_type: stepTag,
    status: outcome.status === 'error' ? 'failed' : outcome.status,
    sent_at: outcome.status === 'sent' ? new Date().toISOString() : null,
    external_id: outcome.externalId ?? null,
    error_message: outcome.status === 'error' ? outcome.detail ?? null : null,
    metadata: { sequence_step_id: step.id, owner: step.owner, offset_minutes: step.offset_minutes },
  })

  // Stamp legacy booleans so switching executors never double-sends.
  const legacyTag = (step.metadata?.legacy as string) || null
  const flag = legacyTag ? LEGACY_FLAG_BY_TAG[legacyTag] : null
  if (flag && outcome.status === 'sent') {
    await supabase.from('appointments').update({ [flag]: true }).eq('id', apt.id)
  }
}
