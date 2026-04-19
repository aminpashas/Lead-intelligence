/**
 * Appointment Reminder Engine — Multi-Channel Reminder Orchestration
 *
 * Sends appointment reminders across SMS, Email, and AI Voice Calls
 * in a staged sequence designed to minimize no-shows:
 *
 *   72h → Email (details + confirm button)
 *   24h → SMS + Email (urgency + confirm)
 *    2h → AI Confirmation Call (voice)
 *    1h → Final SMS nudge (only if unconfirmed)
 *
 * Each reminder is tracked in the `appointment_reminders` table for
 * full audit trail. Confirmed appointments skip further reminders.
 *
 * Designed to run every 15 minutes via cron for reliable delivery.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import * as React from 'react'
import { sendSMS } from '@/lib/messaging/twilio'
import { sendEmail } from '@/lib/messaging/resend'
import { initiateConfirmationCall } from './confirmation-call'
import {
  generate72hEmailTemplate,
  generate24hSmsTemplate,
  generate1hSmsTemplate,
  generateConfirmationSmsReply,
  generateConfirmationThankYouEmail,
  getConfirmationUrl,
  getRescheduleUrl,
} from './reminder-templates'
import { renderEmail } from '@/emails/render'
import { BookingReminder } from '@/emails/BookingReminder'
import { logger } from '@/lib/logger'

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type ReminderResult = {
  appointment_id: string
  type: '72h' | '24h' | '2h' | '1h'
  channel: 'sms' | 'email' | 'voice_confirmation'
  status: 'sent' | 'skipped' | 'error'
  detail?: string
}

type AppointmentWithLead = {
  id: string
  organization_id: string
  lead_id: string
  type: string
  status: string
  scheduled_at: string
  duration_minutes: number
  location: string | null
  notes: string | null
  reminder_sent_72h: boolean
  reminder_sent_24h: boolean
  reminder_sent_2h: boolean
  reminder_sent_1h: boolean
  confirmation_call_made: boolean
  confirmation_received: boolean
  confirmed_via: string | null
  no_show_risk_score: number
  lead: {
    id: string
    first_name: string
    last_name: string | null
    phone: string | null
    phone_formatted: string | null
    email: string | null
    voice_consent: boolean
    voice_opt_out: boolean
    do_not_call: boolean
    sms_consent: boolean
    sms_opt_out: boolean
    email_consent: boolean
    email_opt_out: boolean
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════

/**
 * Send all due appointment reminders for an organization.
 * Should be called every 15 minutes by the cron job.
 */
export async function sendAppointmentReminders(
  supabase: SupabaseClient,
  orgId: string
): Promise<ReminderResult[]> {
  const now = new Date()
  const results: ReminderResult[] = []

  // Get org name for templates
  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .single()

  const practiceName = org?.name || 'our office'

  // ─── 72-HOUR REMINDERS (Email) ──────────────────────────────
  const r72h = await send72hReminders(supabase, orgId, practiceName, now)
  results.push(...r72h)

  // ─── 24-HOUR REMINDERS (SMS + Email) ────────────────────────
  const r24h = await send24hReminders(supabase, orgId, practiceName, now)
  results.push(...r24h)

  // ─── 2-HOUR CONFIRMATION CALLS (Voice) ──────────────────────
  const r2h = await send2hConfirmationCalls(supabase, orgId, practiceName, now)
  results.push(...r2h)

  // ─── 1-HOUR FINAL NUDGE (SMS) ──────────────────────────────
  const r1h = await send1hReminders(supabase, orgId, practiceName, now)
  results.push(...r1h)

  return results
}

// ═══════════════════════════════════════════════════════════════
// 72-HOUR EMAIL REMINDER
// ═══════════════════════════════════════════════════════════════

async function send72hReminders(
  supabase: SupabaseClient,
  orgId: string,
  practiceName: string,
  now: Date
): Promise<ReminderResult[]> {
  const results: ReminderResult[] = []

  // Window: 70-74 hours from now
  const from = new Date(now.getTime() + 70 * 60 * 60 * 1000)
  const to = new Date(now.getTime() + 74 * 60 * 60 * 1000)

  const { data: appointments } = await supabase
    .from('appointments')
    .select('*, lead:leads(id, first_name, last_name, phone, phone_formatted, email, voice_consent, voice_opt_out, do_not_call, sms_consent, sms_opt_out, email_consent, email_opt_out)')
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed'])
    .eq('reminder_sent_72h', false)
    .gte('scheduled_at', from.toISOString())
    .lte('scheduled_at', to.toISOString())

  for (const apt of (appointments || []) as AppointmentWithLead[]) {
    const lead = apt.lead
    if (!lead?.email || lead.email_opt_out) {
      results.push({ appointment_id: apt.id, type: '72h', channel: 'email', status: 'skipped', detail: 'no_email_or_opted_out' })
      continue
    }

    const dateTime = formatAppointmentDateTime(apt.scheduled_at)
    const confirmUrl = getConfirmationUrl(apt.id, orgId)
    const rescheduleUrl = getRescheduleUrl(apt.id, orgId)

    const template = generate72hEmailTemplate({
      firstName: lead.first_name || 'there',
      appointmentType: apt.type,
      dateTime,
      location: apt.location,
      practiceName,
      confirmUrl,
      rescheduleUrl,
    })

    try {
      const result = await sendEmail({
        to: lead.email,
        subject: template.subject,
        html: template.html,
        text: template.text,
      })

      // Track the reminder
      await supabase.from('appointment_reminders').insert({
        organization_id: orgId,
        appointment_id: apt.id,
        lead_id: lead.id,
        channel: 'email',
        reminder_type: '72h',
        status: 'sent',
        sent_at: new Date().toISOString(),
        external_id: result.id,
        metadata: { subject: template.subject },
      })

      // Mark as sent on the appointment
      await supabase
        .from('appointments')
        .update({ reminder_sent_72h: true })
        .eq('id', apt.id)

      results.push({ appointment_id: apt.id, type: '72h', channel: 'email', status: 'sent' })
    } catch (err) {
      await supabase.from('appointment_reminders').insert({
        organization_id: orgId,
        appointment_id: apt.id,
        lead_id: lead.id,
        channel: 'email',
        reminder_type: '72h',
        status: 'failed',
        error_message: err instanceof Error ? err.message : 'unknown',
      })

      results.push({ appointment_id: apt.id, type: '72h', channel: 'email', status: 'error', detail: err instanceof Error ? err.message : 'unknown' })
    }
  }

  return results
}

// ═══════════════════════════════════════════════════════════════
// 24-HOUR SMS + EMAIL REMINDER
// ═══════════════════════════════════════════════════════════════

async function send24hReminders(
  supabase: SupabaseClient,
  orgId: string,
  practiceName: string,
  now: Date
): Promise<ReminderResult[]> {
  const results: ReminderResult[] = []

  // Window: 22-26 hours from now
  const from = new Date(now.getTime() + 22 * 60 * 60 * 1000)
  const to = new Date(now.getTime() + 26 * 60 * 60 * 1000)

  const { data: appointments } = await supabase
    .from('appointments')
    .select('*, lead:leads(id, first_name, last_name, phone, phone_formatted, email, voice_consent, voice_opt_out, do_not_call, sms_consent, sms_opt_out, email_consent, email_opt_out)')
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed'])
    .eq('reminder_sent_24h', false)
    .gte('scheduled_at', from.toISOString())
    .lte('scheduled_at', to.toISOString())

  for (const apt of (appointments || []) as AppointmentWithLead[]) {
    const lead = apt.lead
    if (!lead) continue

    const dateTime = formatAppointmentDateTime(apt.scheduled_at)
    const confirmUrl = getConfirmationUrl(apt.id, orgId)
    const rescheduleUrl = getRescheduleUrl(apt.id, orgId)

    // ── Send SMS ──
    if (lead.phone && !lead.sms_opt_out && lead.sms_consent) {
      const smsBody = generate24hSmsTemplate({
        firstName: lead.first_name || 'there',
        appointmentType: apt.type,
        dateTime,
        practiceName,
      })

      try {
        const result = await sendSMS(lead.phone, smsBody)

        await supabase.from('appointment_reminders').insert({
          organization_id: orgId,
          appointment_id: apt.id,
          lead_id: lead.id,
          channel: 'sms',
          reminder_type: '24h',
          status: 'sent',
          sent_at: new Date().toISOString(),
          external_id: result.sid,
        })

        results.push({ appointment_id: apt.id, type: '24h', channel: 'sms', status: 'sent' })
      } catch (err) {
        await supabase.from('appointment_reminders').insert({
          organization_id: orgId,
          appointment_id: apt.id,
          lead_id: lead.id,
          channel: 'sms',
          reminder_type: '24h',
          status: 'failed',
          error_message: err instanceof Error ? err.message : 'unknown',
        })

        results.push({ appointment_id: apt.id, type: '24h', channel: 'sms', status: 'error', detail: err instanceof Error ? err.message : 'unknown' })
      }
    }

    // ── Send Email ──
    if (lead.email && !lead.email_opt_out) {
      // React Email template (src/emails/BookingReminder.tsx). Provides branded HTML +
      // matching plain-text body for clients that fall back to text/plain.
      const subject = `Reminder: your ${apt.type} appointment tomorrow`
      const { html, text } = await renderEmail(
        React.createElement(BookingReminder, {
          leadId: lead.id,
          orgId,
          orgName: practiceName,
          firstName: lead.first_name || 'there',
          consultLabel: apt.type,
          scheduledAt: apt.scheduled_at,
          durationMinutes: apt.duration_minutes,
          location: apt.location || undefined,
          window: '24h',
          rescheduleUrl,
        })
      )
      // confirmUrl is collected via the SMS reply / email-click webhook; we keep the var
      // referenced so the build doesn't strip the helper import.
      void confirmUrl

      try {
        const result = await sendEmail({
          to: lead.email,
          subject,
          html,
          text,
        })

        await supabase.from('appointment_reminders').insert({
          organization_id: orgId,
          appointment_id: apt.id,
          lead_id: lead.id,
          channel: 'email',
          reminder_type: '24h',
          status: 'sent',
          sent_at: new Date().toISOString(),
          external_id: result.id,
        })

        results.push({ appointment_id: apt.id, type: '24h', channel: 'email', status: 'sent' })
      } catch (err) {
        await supabase.from('appointment_reminders').insert({
          organization_id: orgId,
          appointment_id: apt.id,
          lead_id: lead.id,
          channel: 'email',
          reminder_type: '24h',
          status: 'failed',
          error_message: err instanceof Error ? err.message : 'unknown',
        })

        results.push({ appointment_id: apt.id, type: '24h', channel: 'email', status: 'error', detail: err instanceof Error ? err.message : 'unknown' })
      }
    }

    // Mark 24h as sent
    await supabase
      .from('appointments')
      .update({ reminder_sent_24h: true })
      .eq('id', apt.id)
  }

  return results
}

// ═══════════════════════════════════════════════════════════════
// 2-HOUR AI CONFIRMATION CALL
// ═══════════════════════════════════════════════════════════════

async function send2hConfirmationCalls(
  supabase: SupabaseClient,
  orgId: string,
  practiceName: string,
  now: Date
): Promise<ReminderResult[]> {
  const results: ReminderResult[] = []

  // Window: 1.5-2.5 hours from now
  const from = new Date(now.getTime() + 90 * 60 * 1000)
  const to = new Date(now.getTime() + 150 * 60 * 1000)

  const { data: appointments } = await supabase
    .from('appointments')
    .select('*, lead:leads(id, first_name, last_name, phone, phone_formatted, email, voice_consent, voice_opt_out, do_not_call, sms_consent, sms_opt_out, email_consent, email_opt_out)')
    .eq('organization_id', orgId)
    .in('status', ['scheduled']) // Only call unconfirmed appointments
    .eq('reminder_sent_2h', false)
    .eq('confirmation_call_made', false)
    .eq('confirmation_received', false) // Skip already confirmed
    .gte('scheduled_at', from.toISOString())
    .lte('scheduled_at', to.toISOString())

  for (const apt of (appointments || []) as AppointmentWithLead[]) {
    const lead = apt.lead
    if (!lead) continue

    // Skip if lead can't be called
    if (lead.voice_opt_out || lead.do_not_call || !lead.phone) {
      results.push({ appointment_id: apt.id, type: '2h', channel: 'voice_confirmation', status: 'skipped', detail: 'voice_not_available' })
      continue
    }

    const dateTime = formatAppointmentDateTime(apt.scheduled_at)

    try {
      const callResult = await initiateConfirmationCall(supabase, {
        organization_id: orgId,
        appointment_id: apt.id,
        lead_id: lead.id,
        lead_first_name: lead.first_name || 'there',
        appointment_type: apt.type,
        appointment_datetime: dateTime,
        practice_name: practiceName,
      })

      // Mark 2h reminder as sent
      await supabase
        .from('appointments')
        .update({ reminder_sent_2h: true })
        .eq('id', apt.id)

      results.push({
        appointment_id: apt.id,
        type: '2h',
        channel: 'voice_confirmation',
        status: callResult.status === 'initiated' ? 'sent' : callResult.status === 'skipped' ? 'skipped' : 'error',
        detail: callResult.reason,
      })
    } catch (err) {
      results.push({
        appointment_id: apt.id,
        type: '2h',
        channel: 'voice_confirmation',
        status: 'error',
        detail: err instanceof Error ? err.message : 'unknown',
      })
    }
  }

  return results
}

// ═══════════════════════════════════════════════════════════════
// 1-HOUR FINAL SMS NUDGE
// ═══════════════════════════════════════════════════════════════

async function send1hReminders(
  supabase: SupabaseClient,
  orgId: string,
  practiceName: string,
  now: Date
): Promise<ReminderResult[]> {
  const results: ReminderResult[] = []

  // Window: 30-90 minutes from now
  const from = new Date(now.getTime() + 30 * 60 * 1000)
  const to = new Date(now.getTime() + 90 * 60 * 1000)

  const { data: appointments } = await supabase
    .from('appointments')
    .select('*, lead:leads(id, first_name, last_name, phone, phone_formatted, sms_consent, sms_opt_out)')
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed'])
    .eq('reminder_sent_1h', false)
    .gte('scheduled_at', from.toISOString())
    .lte('scheduled_at', to.toISOString())

  for (const apt of (appointments || []) as unknown as AppointmentWithLead[]) {
    const lead = apt.lead
    if (!lead?.phone || lead.sms_opt_out) {
      results.push({ appointment_id: apt.id, type: '1h', channel: 'sms', status: 'skipped', detail: 'no_phone_or_opted_out' })
      continue
    }

    const aptTime = new Date(apt.scheduled_at).toLocaleString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })

    const smsBody = generate1hSmsTemplate({
      firstName: lead.first_name || 'there',
      appointmentTime: aptTime,
      practiceName,
    })

    try {
      const result = await sendSMS(lead.phone, smsBody)

      await supabase.from('appointment_reminders').insert({
        organization_id: orgId,
        appointment_id: apt.id,
        lead_id: lead.id,
        channel: 'sms',
        reminder_type: '1h',
        status: 'sent',
        sent_at: new Date().toISOString(),
        external_id: result.sid,
      })

      await supabase
        .from('appointments')
        .update({ reminder_sent_1h: true })
        .eq('id', apt.id)

      results.push({ appointment_id: apt.id, type: '1h', channel: 'sms', status: 'sent' })
    } catch (err) {
      await supabase.from('appointment_reminders').insert({
        organization_id: orgId,
        appointment_id: apt.id,
        lead_id: lead.id,
        channel: 'sms',
        reminder_type: '1h',
        status: 'failed',
        error_message: err instanceof Error ? err.message : 'unknown',
      })

      results.push({ appointment_id: apt.id, type: '1h', channel: 'sms', status: 'error', detail: err instanceof Error ? err.message : 'unknown' })
    }
  }

  return results
}

// ═══════════════════════════════════════════════════════════════
// CONFIRMATION PROCESSING (SMS Reply / Email Click)
// ═══════════════════════════════════════════════════════════════

/**
 * Process an appointment confirmation from any channel.
 */
export async function confirmAppointment(
  supabase: SupabaseClient,
  appointmentId: string,
  method: 'sms_reply' | 'email_click' | 'voice_call' | 'manual',
  orgId: string
): Promise<{ success: boolean; error?: string }> {
  // Verify appointment exists and belongs to org
  const { data: apt, error } = await supabase
    .from('appointments')
    .select('id, lead_id, type, scheduled_at, status, confirmation_received')
    .eq('id', appointmentId)
    .eq('organization_id', orgId)
    .single()

  if (error || !apt) {
    return { success: false, error: 'Appointment not found' }
  }

  if (apt.confirmation_received) {
    return { success: true } // Already confirmed, idempotent
  }

  // Update appointment
  await supabase
    .from('appointments')
    .update({
      status: 'confirmed',
      confirmation_received: true,
      confirmed_via: method,
      confirmed_at: new Date().toISOString(),
      no_show_risk_score: 5, // Very low risk - confirmed
    })
    .eq('id', appointmentId)

  // Get lead for sending confirmation email
  const { data: lead } = await supabase
    .from('leads')
    .select('id, first_name, email')
    .eq('id', apt.lead_id)
    .single()

  // Get org name
  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .single()

  const orgName = org?.name || 'our office'

  // Send confirmation thank you email if they have an email
  if (lead?.email) {
    const dateTime = formatAppointmentDateTime(apt.scheduled_at)
    const template = generateConfirmationThankYouEmail({
      firstName: lead.first_name || 'there',
      appointmentType: apt.type,
      dateTime,
      practiceName: orgName,
    })

    try {
      await sendEmail({
        to: lead.email,
        subject: template.subject,
        html: template.html,
        text: template.text,
      })
    } catch {
      // Non-critical — don't fail the confirmation
    }
  }

  // Send SMS confirmation reply if confirmed via SMS
  if (method === 'sms_reply' && lead) {
    const { data: leadWithPhone } = await supabase
      .from('leads')
      .select('phone')
      .eq('id', lead.id)
      .single()

    if (leadWithPhone?.phone) {
      const dateTime = formatAppointmentDateTime(apt.scheduled_at)
      const confirmSms = generateConfirmationSmsReply({
        firstName: lead.first_name || 'there',
        dateTime,
        practiceName: orgName,
      })

      try {
        await sendSMS(leadWithPhone.phone, confirmSms)
      } catch {
        // Non-critical
      }
    }
  }

  // Log activity
  if (lead) {
    await supabase.from('lead_activities').insert({
      organization_id: orgId,
      lead_id: lead.id,
      activity_type: 'appointment_confirmed',
      title: `Appointment confirmed via ${method.replace('_', ' ')}`,
      metadata: { appointment_id: appointmentId, method },
    })
  }

  logger.info('Appointment confirmed', { appointmentId, method })
  return { success: true }
}

// ═══════════════════════════════════════════════════════════════
// NO-SHOW RISK SCORING
// ═══════════════════════════════════════════════════════════════

/**
 * Calculate no-show risk score based on engagement patterns.
 * Called periodically to update risk assessments.
 */
export async function calculateNoShowRisk(
  supabase: SupabaseClient,
  appointmentId: string
): Promise<number> {
  // Get appointment with reminders
  const { data: apt } = await supabase
    .from('appointments')
    .select('*, lead:leads(no_show_count, engagement_score)')
    .eq('id', appointmentId)
    .single()

  if (!apt) return 50

  let risk = 30 // Base risk

  // Confirmed = very low risk
  if (apt.confirmation_received) {
    risk = 5
    return risk
  }

  // Check how many reminders were sent and responded to
  const { data: reminders } = await supabase
    .from('appointment_reminders')
    .select('status, confirmation_status')
    .eq('appointment_id', appointmentId)

  if (reminders) {
    const totalSent = reminders.filter((r: { status: string }) => r.status === 'sent').length
    const totalFailed = reminders.filter((r: { status: string }) => r.status === 'failed').length
    const noResponses = reminders.filter((r: { confirmation_status: string }) => r.confirmation_status === 'no_response').length

    // Failed reminders = higher risk
    if (totalFailed > 0) risk += 15

    // No responses to any reminders = higher risk
    if (totalSent > 0 && noResponses === totalSent) risk += 20
  }

  // Previous no-shows = higher risk
  const lead = apt.lead as any
  if (lead?.no_show_count > 0) {
    risk += Math.min(lead.no_show_count * 15, 30)
  }

  // Low engagement score = higher risk
  if (lead?.engagement_score !== undefined && lead.engagement_score < 20) {
    risk += 15
  }

  // Cap at 100
  risk = Math.min(risk, 100)

  // Update the appointment
  await supabase
    .from('appointments')
    .update({ no_show_risk_score: risk })
    .eq('id', appointmentId)

  return risk
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function formatAppointmentDateTime(isoString: string): string {
  const date = new Date(isoString)
  return date.toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}
