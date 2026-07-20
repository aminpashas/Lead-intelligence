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
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { setPendingReplyIntent } from '@/lib/messaging/pending-intent'
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
import { computeNoShowRisk, isCheckinExpired, CHECKIN_REPLY_WINDOW_MS } from './attendance-risk'
import { runAttendanceEscalation } from './attendance-escalation'
import { renderEmail } from '@/emails/render'
import { parseBranding, type BrandLogistics } from '@/lib/branding/schema'
import { resolveBrandForContext } from '@/lib/branding/resolve-brand'
import { renderVisitLogistics } from '@/lib/branding/visit-logistics'
import { BookingReminder } from '@/emails/BookingReminder'
import { logger } from '@/lib/logger'
import { decryptLeadPII } from '@/lib/encryption'
import { resolvePracticeTimeZone } from '@/lib/time/practice-timezone'

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type ReminderResult = {
  appointment_id: string
  type: '72h' | '24h' | '2h' | '1h' | 'checkin_4h' | 'escalation'
  channel: 'sms' | 'email' | 'voice_confirmation' | 'slack'
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
    // Brand-signal fields (see resolveBrandServiceLine) so each reminder can
    // carry the same per-service-line DBA the patient heard at booking.
    tags: string[] | null
    custom_fields: Record<string, unknown> | null
    utm_campaign: string | null
    utm_source: string | null
    campaign_attribution: Record<string, unknown> | null
  }
}

/** Per-lead brand name: resolves the same DBA the booking confirmation used
 *  (implant-signalled leads → Dion Health brand slot; TMJ brand only for
 *  explicit TMJ/sleep signals), falling back to the org display name. */
export type BrandNameResolver = (lead: unknown) => string

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

  // Get org name + branding for templates. Logistics (address / by-car / BART /
  // what-to-expect) is org-shared, so we render it once and attach it to the
  // reminder emails — same directions patients got at booking, so they still
  // know where to go days later.
  const { data: org } = await supabase
    .from('organizations')
    .select('name, settings')
    .eq('id', orgId)
    .single()

  const orgDisplayName = org?.name || 'our office'
  const branding = parseBranding((org?.settings as Record<string, unknown> | null)?.branding)
  const brandLogistics = branding.logistics

  // Same per-lead DBA resolution the booking confirmation uses, so a patient
  // booked under "Dion Health" isn't reminded by "SF Dentistry" the next day.
  const brandNameFor: BrandNameResolver = (lead) =>
    resolveBrandForContext(branding, orgDisplayName, { lead: lead as never }).practiceName

  // Resolve the practice timezone ONCE so every reminder tier renders the
  // appointment time in the patient's local zone rather than the server's
  // (UTC on Vercel). Without this an 11 AM Pacific consult goes out as "6 PM".
  const timeZone = await resolvePracticeTimeZone(supabase, orgId)

  // ─── RISK REFRESH ───────────────────────────────────────────
  // Recompute for everything inside 48h each run. Risk is derived from things
  // that change AFTER booking (reminders going unanswered, a check-in expiring),
  // so a score computed once at booking time is stale by the day of the visit —
  // and the escalation ladder below reads exactly this number.
  const horizon = new Date(now.getTime() + 48 * 60 * 60 * 1000)
  const { data: upcoming } = await supabase
    .from('appointments')
    .select('id')
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed'])
    .gte('scheduled_at', now.toISOString())
    .lte('scheduled_at', horizon.toISOString())
  for (const a of upcoming || []) {
    await calculateNoShowRisk(supabase, a.id)
  }

  // ─── ESCALATION LADDER (risk-based, day-of) ─────────────────
  // Runs BEFORE the fixed-time tiers so a tier-1 check-in sent this pass can be
  // seen by the 2h confirmation-call query in the same run.
  const esc = await runAttendanceEscalation(supabase, orgId, brandNameFor, now, timeZone)
  results.push(...esc)

  // ─── 72-HOUR REMINDERS (Email) ──────────────────────────────
  const r72h = await send72hReminders(supabase, orgId, brandNameFor, now, brandLogistics, timeZone)
  results.push(...r72h)

  // ─── 24-HOUR REMINDERS (SMS + Email) ────────────────────────
  const r24h = await send24hReminders(supabase, orgId, brandNameFor, now, brandLogistics, timeZone)
  results.push(...r24h)

  // ─── 2-HOUR CONFIRMATION CALLS (Voice) ──────────────────────
  const r2h = await send2hConfirmationCalls(supabase, orgId, brandNameFor, now, timeZone)
  results.push(...r2h)

  // ─── 1-HOUR FINAL NUDGE (SMS) ──────────────────────────────
  const r1h = await send1hReminders(supabase, orgId, brandNameFor, now, timeZone)
  results.push(...r1h)

  return results
}

// ═══════════════════════════════════════════════════════════════
// 72-HOUR EMAIL REMINDER
// ═══════════════════════════════════════════════════════════════

async function send72hReminders(
  supabase: SupabaseClient,
  orgId: string,
  brandNameFor: BrandNameResolver,
  now: Date,
  brandLogistics: BrandLogistics,
  timeZone: string
): Promise<ReminderResult[]> {
  const results: ReminderResult[] = []
  const logistics = renderVisitLogistics({ logistics: brandLogistics })

  // Window: 70-74 hours from now
  const from = new Date(now.getTime() + 70 * 60 * 60 * 1000)
  const to = new Date(now.getTime() + 74 * 60 * 60 * 1000)

  const { data: appointments } = await supabase
    .from('appointments')
    .select('*, lead:leads(id, first_name, last_name, phone, phone_formatted, email, voice_consent, voice_opt_out, do_not_call, sms_consent, sms_opt_out, email_consent, email_opt_out, tags, custom_fields, utm_campaign, utm_source, campaign_attribution)')
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed'])
    .eq('reminder_sent_72h', false)
    .gte('scheduled_at', from.toISOString())
    .lte('scheduled_at', to.toISOString())

  for (const apt of (appointments || []) as AppointmentWithLead[]) {
    // Decrypt PII (email/phone) before use — raw enc:: values are invalid recipients.
    const lead = apt.lead ? decryptLeadPII(apt.lead) : apt.lead
    if (!lead?.email || lead.email_opt_out) {
      results.push({ appointment_id: apt.id, type: '72h', channel: 'email', status: 'skipped', detail: 'no_email_or_opted_out' })
      continue
    }

    const dateTime = formatAppointmentDateTime(apt.scheduled_at, timeZone)
    const confirmUrl = getConfirmationUrl(apt.id, orgId)
    const rescheduleUrl = getRescheduleUrl(apt.id, orgId)
    const practiceName = brandNameFor(lead)

    const template = generate72hEmailTemplate({
      firstName: lead.first_name || 'there',
      appointmentType: apt.type,
      dateTime,
      location: apt.location,
      practiceName,
      confirmUrl,
      rescheduleUrl,
      logisticsHtml: logistics.emailHtml,
      logisticsText: logistics.emailText,
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
  brandNameFor: BrandNameResolver,
  now: Date,
  brandLogistics: BrandLogistics,
  timeZone: string
): Promise<ReminderResult[]> {
  const results: ReminderResult[] = []

  // Window: 22-26 hours from now
  const from = new Date(now.getTime() + 22 * 60 * 60 * 1000)
  const to = new Date(now.getTime() + 26 * 60 * 60 * 1000)

  const { data: appointments } = await supabase
    .from('appointments')
    .select('*, lead:leads(id, first_name, last_name, phone, phone_formatted, email, voice_consent, voice_opt_out, do_not_call, sms_consent, sms_opt_out, email_consent, email_opt_out, tags, custom_fields, utm_campaign, utm_source, campaign_attribution)')
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed'])
    .eq('reminder_sent_24h', false)
    .gte('scheduled_at', from.toISOString())
    .lte('scheduled_at', to.toISOString())

  for (const apt of (appointments || []) as AppointmentWithLead[]) {
    // Decrypt PII (email/phone) before use — raw enc:: values are invalid recipients.
    const lead = apt.lead ? decryptLeadPII(apt.lead) : apt.lead
    if (!lead) continue

    const dateTime = formatAppointmentDateTime(apt.scheduled_at, timeZone)
    const confirmUrl = getConfirmationUrl(apt.id, orgId)
    const rescheduleUrl = getRescheduleUrl(apt.id, orgId)
    const practiceName = brandNameFor(lead)

    // ── Send SMS ── (consent assumed; only a phone + no DND required)
    if (lead.phone && !lead.sms_opt_out) {
      const smsBody = generate24hSmsTemplate({
        firstName: lead.first_name || 'there',
        appointmentType: apt.type,
        dateTime,
        practiceName,
      })

      try {
        const sendRes = await sendSMSToLead({ supabase, leadId: lead.id, to: lead.phone, body: smsBody, caller: 'reminders.24h' })
        if (!sendRes.sent) throw new Error(`sms_not_sent:${sendRes.reason}`)
        const result = { sid: sendRes.sid }

        // The 24h reminder asks "Reply YES to confirm" — stamp the intent so the
        // inbound webhook confirms THIS appointment on a YES, instead of a YES to
        // some other flow (e.g. financing) being misread as a confirmation.
        await setPendingReplyIntent(supabase, {
          organizationId: orgId,
          leadId: lead.id,
          intent: 'appointment_confirm',
          refType: 'appointment',
          refId: apt.id,
        })

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
          logistics: brandLogistics,
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
  brandNameFor: BrandNameResolver,
  now: Date,
  timeZone: string
): Promise<ReminderResult[]> {
  const results: ReminderResult[] = []

  // Window: 1.5-2.5 hours from now
  const from = new Date(now.getTime() + 90 * 60 * 1000)
  const to = new Date(now.getTime() + 150 * 60 * 1000)

  const { data: appointments } = await supabase
    .from('appointments')
    .select('*, lead:leads(id, first_name, last_name, phone, phone_formatted, email, voice_consent, voice_opt_out, do_not_call, sms_consent, sms_opt_out, email_consent, email_opt_out, tags, custom_fields, utm_campaign, utm_source, campaign_attribution)')
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed'])
    .eq('reminder_sent_2h', false)
    .eq('confirmation_call_made', false)
    // Unconfirmed appointments — OR confirmed ones whose morning-of check-in
    // went out and then sat unanswered past the reply window. Two hours of
    // silence on the day of the visit makes a confirmation from last week
    // stale, so the AI call is re-armed rather than skipped.
    .or(
      `confirmation_received.eq.false,and(checkin_sent_at.lt.${new Date(now.getTime() - CHECKIN_REPLY_WINDOW_MS).toISOString()},checkin_replied_at.is.null)`
    )
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

    const dateTime = formatAppointmentDateTime(apt.scheduled_at, timeZone)

    try {
      const callResult = await initiateConfirmationCall(supabase, {
        organization_id: orgId,
        appointment_id: apt.id,
        lead_id: lead.id,
        lead_first_name: lead.first_name || 'there',
        appointment_type: apt.type,
        appointment_datetime: dateTime,
        practice_name: brandNameFor(lead),
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
  brandNameFor: BrandNameResolver,
  now: Date,
  timeZone: string
): Promise<ReminderResult[]> {
  const results: ReminderResult[] = []

  // Window: 30-90 minutes from now
  const from = new Date(now.getTime() + 30 * 60 * 1000)
  const to = new Date(now.getTime() + 90 * 60 * 1000)

  const { data: appointments } = await supabase
    .from('appointments')
    .select('*, lead:leads(id, first_name, last_name, phone, phone_formatted, sms_consent, sms_opt_out, tags, custom_fields, utm_campaign, utm_source, campaign_attribution)')
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed'])
    .eq('reminder_sent_1h', false)
    .gte('scheduled_at', from.toISOString())
    .lte('scheduled_at', to.toISOString())

  for (const apt of (appointments || []) as unknown as AppointmentWithLead[]) {
    // Decrypt PII (email/phone) before use — raw enc:: values are invalid recipients.
    const lead = apt.lead ? decryptLeadPII(apt.lead) : apt.lead
    if (!lead?.phone || lead.sms_opt_out) {
      results.push({ appointment_id: apt.id, type: '1h', channel: 'sms', status: 'skipped', detail: 'no_phone_or_opted_out' })
      continue
    }

    const aptTime = new Date(apt.scheduled_at).toLocaleString('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })

    const smsBody = generate1hSmsTemplate({
      firstName: lead.first_name || 'there',
      appointmentTime: aptTime,
      practiceName: brandNameFor(lead),
    })

    try {
      const sendRes = await sendSMSToLead({ supabase, leadId: lead.id, to: lead.phone, body: smsBody, caller: 'reminders.1h' })
      if (!sendRes.sent) {
        results.push({ appointment_id: apt.id, type: '1h', channel: 'sms', status: 'skipped', detail: `consent:${sendRes.reason}` })
        continue
      }
      const result = { sid: sendRes.sid }

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
    })
    .eq('id', appointmentId)

  // Confirmation LOWERS risk (base 30 → 5) but no longer erases history. Prior
  // no-shows, dead reminders and an ignored check-in still count, so a serial
  // no-shower who texts "C" no longer reads as zero-risk and drops off the
  // escalation ladder entirely — which is why confirmed patients still no-showed.
  await calculateNoShowRisk(supabase, appointmentId)

  // Get lead for sending confirmation. PII columns (email, phone) are stored
  // AES-encrypted at rest (enc::…) — they MUST be decrypted before handing to
  // Resend/Twilio or the send fails on an invalid recipient. decryptLeadPII
  // passes plaintext through untouched, so it's safe for legacy rows too.
  const { data: leadRaw } = await supabase
    .from('leads')
    .select('id, first_name, email, phone, tags, custom_fields, utm_campaign, utm_source, campaign_attribution')
    .eq('id', apt.lead_id)
    .single()

  const lead = leadRaw ? decryptLeadPII(leadRaw) : null

  // Get org name + branding, and resolve the lead's service-line DBA so the
  // thank-you carries the same brand as the booking confirmation and reminders.
  const { data: org } = await supabase
    .from('organizations')
    .select('name, settings')
    .eq('id', orgId)
    .single()

  const branding = parseBranding((org?.settings as Record<string, unknown> | null)?.branding)
  const orgName = resolveBrandForContext(branding, org?.name || 'our office', {
    lead: (lead as never) ?? null,
  }).practiceName
  const timeZone = await resolvePracticeTimeZone(supabase, orgId)
  const dateTime = formatAppointmentDateTime(apt.scheduled_at, timeZone)

  // Notify the patient on every consented channel (text + email) regardless of
  // how the confirmation arrived. Consent/opt-out/quiet-hours are enforced inside
  // sendSMSToLead; the thank-you email is transactional. Send failures are logged
  // (not silently swallowed) but never fail the confirmation itself.
  if (lead?.email) {
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
    } catch (err) {
      logger.warn('Confirmation thank-you email failed', {
        appointmentId,
        error: err instanceof Error ? err.message : 'unknown',
      })
    }
  }

  if (lead?.phone) {
    const confirmSms = generateConfirmationSmsReply({
      firstName: lead.first_name || 'there',
      dateTime,
      practiceName: orgName,
    })

    try {
      const res = await sendSMSToLead({ supabase, leadId: lead.id, to: lead.phone, body: confirmSms, caller: 'reminders.confirmation' })
      if (!res.sent) {
        logger.info('Confirmation SMS not sent', { appointmentId, reason: res.reason })
      }
    } catch (err) {
      logger.warn('Confirmation SMS failed', {
        appointmentId,
        error: err instanceof Error ? err.message : 'unknown',
      })
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
  const { data: apt } = await supabase
    .from('appointments')
    // Single string literal on purpose: supabase-js infers the row type by
    // parsing this as a literal type, and `'a, ' + 'b'` widens to `string`,
    // which collapses the whole result to GenericStringError.
    .select('confirmation_received, checkin_sent_at, checkin_replied_at, lead:leads(no_show_count, engagement_score)')
    .eq('id', appointmentId)
    .single()

  if (!apt) return 50

  const { data: reminders } = await supabase
    .from('appointment_reminders')
    .select('status, confirmation_status')
    .eq('appointment_id', appointmentId)

  const rows = reminders ?? []
  // PostgREST types an embedded relation as an array here even though the FK is
  // to-one, so normalize both shapes rather than trusting either.
  type LeadRisk = { no_show_count: number | null; engagement_score: number | null }
  const rawLead = apt.lead as unknown as LeadRisk | LeadRisk[] | null
  const lead: LeadRisk | null = Array.isArray(rawLead) ? rawLead[0] ?? null : rawLead

  const risk = computeNoShowRisk({
    confirmed: !!apt.confirmation_received,
    priorNoShows: lead?.no_show_count ?? 0,
    engagementScore: lead?.engagement_score ?? null,
    remindersSent: rows.filter((r: { status: string }) => r.status === 'sent').length,
    remindersFailed: rows.filter((r: { status: string }) => r.status === 'failed').length,
    remindersUnanswered: rows.filter(
      (r: { confirmation_status: string }) => r.confirmation_status === 'no_response'
    ).length,
    checkinExpiredUnanswered: isCheckinExpired(
      apt.checkin_sent_at as string | null,
      apt.checkin_replied_at as string | null,
      new Date()
    ),
  })

  // Always persist. The old version early-returned 5 for confirmed appointments
  // WITHOUT writing, so a confirmed row silently kept whatever stale score it
  // already had — invisible because the caller's return value looked correct.
  await supabase
    .from('appointments')
    .update({ no_show_risk_score: risk })
    .eq('id', appointmentId)

  return risk
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Human-readable appointment date+time pinned to the practice's IANA timezone.
 *
 * `timeZone` is REQUIRED: without it `toLocaleString` renders in the ambient
 * runtime zone, which is UTC on Vercel — so an 11 AM Pacific consult would go
 * out in the email as "6:00 PM". Callers resolve the zone via
 * `resolvePracticeTimeZone(supabase, orgId)`.
 */
export function formatAppointmentDateTime(isoString: string, timeZone: string): string {
  const date = new Date(isoString)
  return date.toLocaleString('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}
