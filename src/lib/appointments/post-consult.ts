import type { SupabaseClient } from '@supabase/supabase-js'
import { postSlack } from '@/lib/alerts/slack'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { sendEmailToLead } from '@/lib/messaging/resend'
import { generateFeedbackToken } from '@/lib/feedback/review-gating'
import { decryptField } from '@/lib/encryption'
import { logger } from '@/lib/logger'

type AttendanceCandidate = {
  status: string
  scheduled_at: string
  duration_minutes: number | null
  outcome_prompt_sent_at: string | null
}

/** An appointment whose time has passed but has no terminal decision yet. */
export function shouldPromptOutcome(appt: AttendanceCandidate, now: Date): boolean {
  if (appt.status !== 'scheduled' && appt.status !== 'confirmed') return false
  if (appt.outcome_prompt_sent_at) return false
  const end = new Date(appt.scheduled_at).getTime() + (appt.duration_minutes ?? 60) * 60_000
  return end < now.getTime()
}

type FeedbackCandidate = { status: string; outcome_recorded_at: string | null }

/** A showed + outcome-recorded appointment past its feedback delay window. */
export function isFeedbackDue(appt: FeedbackCandidate, now: Date, delayHours: number): boolean {
  if (appt.status !== 'completed' || !appt.outcome_recorded_at) return false
  const due = new Date(appt.outcome_recorded_at).getTime() + delayHours * 3_600_000
  return now.getTime() >= due
}

/** Pass A: flag ended, undecided appointments and Slack a batched digest. */
export async function sweepAttendance(supabase: SupabaseClient, orgId: string): Promise<number> {
  const now = new Date()
  const { data: candidates } = await supabase
    .from('appointments')
    .select('id, status, scheduled_at, duration_minutes, outcome_prompt_sent_at, type, lead:leads(first_name, last_name)')
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed'])
    .is('outcome_prompt_sent_at', null)
    .lt('scheduled_at', now.toISOString())

  const due = (candidates ?? []).filter((a) => shouldPromptOutcome(a as AttendanceCandidate, now))
  if (due.length === 0) return 0

  const ids = due.map((a) => a.id)
  await supabase
    .from('appointments')
    .update({ outcome_review_pending: true, outcome_prompt_sent_at: now.toISOString() })
    .in('id', ids)

  const names = due
    .map((a) => {
      const rawLead = (a as { lead?: unknown }).lead
      const l = (Array.isArray(rawLead) ? rawLead[0] : rawLead) as
        | { first_name?: string | null; last_name?: string | null }
        | undefined
      return `${l?.first_name ?? ''} ${l?.last_name ?? ''}`.trim() || 'a patient'
    })
    .slice(0, 10)
    .join(', ')
  await postSlack(`🗒️ ${due.length} consult${due.length > 1 ? 's' : ''} need an outcome logged: ${names}`)
  return due.length
}

/** Pass B: send feedback requests for showed + outcome-recorded appointments (opt-in orgs). */
export async function dispatchFeedbackRequests(supabase: SupabaseClient, orgId: string): Promise<number> {
  const { data: settings } = await supabase
    .from('booking_settings')
    .select('feedback_request_enabled, google_review_url, feedback_delay_hours')
    .eq('organization_id', orgId)
    .maybeSingle()

  if (!settings?.feedback_request_enabled || !settings.google_review_url) return 0
  const delayHours = settings.feedback_delay_hours ?? 2
  const now = new Date()

  const { data: candidates } = await supabase
    .from('appointments')
    .select('id, status, outcome_recorded_at, lead_id, lead:leads(id, first_name, phone_formatted, email)')
    .eq('organization_id', orgId)
    .eq('status', 'completed')
    .not('outcome_recorded_at', 'is', null)

  const due = (candidates ?? []).filter((a) =>
    isFeedbackDue(a as FeedbackCandidate, now, delayHours)
  )

  let sent = 0
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '')
  for (const appt of due) {
    try {
      // Idempotency: skip if a feedback row already exists for this appointment.
      const { data: existing } = await supabase
        .from('patient_feedback')
        .select('id')
        .eq('appointment_id', appt.id)
        .maybeSingle()
      if (existing) continue

      const rawLead = (appt as { lead?: unknown }).lead
      // Supabase types a to-one join as either an object or a single-element array
      // depending on inference; normalise to the object shape.
      const lead = (Array.isArray(rawLead) ? rawLead[0] : rawLead) as
        | { id: string; first_name?: string | null; phone_formatted?: string | null; email?: string | null }
        | undefined
      if (!lead) continue

      const token = generateFeedbackToken()
      const url = `${base}/feedback/${token}`
      // Lead PII (phone_formatted + email) is encrypted at rest — decrypt before
      // sending, mirroring the canonical send paths (speed-to-lead, funnel/executor).
      const phone = lead.phone_formatted ? (decryptField(lead.phone_formatted) || lead.phone_formatted) : null
      const email = lead.email ? (decryptField(lead.email) || lead.email) : null

      let channel: 'sms' | 'email' | null = null
      // SMS first — consent + quiet-hours + 10DLC gates enforced inside sendSMSToLead.
      if (phone) {
        const res = await sendSMSToLead({
          supabase, leadId: lead.id, to: phone, caller: 'post_consult.feedback',
          body: `Thanks for visiting today${lead.first_name ? `, ${lead.first_name}` : ''}! How did it go? Tap to rate your visit: ${url} (reply STOP to opt out)`,
        }).catch(() => ({ sent: false as const }))
        if (res.sent) channel = 'sms'
      }
      // Fall back to email — consent enforced inside sendEmailToLead.
      if (!channel && email) {
        const res = await sendEmailToLead({
          supabase, leadId: lead.id, to: email, caller: 'post_consult.feedback',
          subject: 'How was your visit?',
          html: `<p>Thanks for visiting today${lead.first_name ? `, ${lead.first_name}` : ''}!</p><p>We'd love your quick feedback — <a href="${url}">tap here to rate your visit</a>.</p>`,
          text: `Thanks for visiting today! Rate your visit: ${url}`,
        }).catch(() => ({ sent: false as const }))
        if (res.sent) channel = 'email'
      }
      if (!channel) continue

      await supabase.from('patient_feedback').insert({
        organization_id: orgId, lead_id: lead.id, appointment_id: appt.id,
        token, channel, status: 'requested',
      })
      sent++
    } catch (err) {
      logger.warn('Feedback dispatch failed for appointment', {
        orgId, appointmentId: appt.id, error: err instanceof Error ? err.message : 'unknown',
      })
    }
  }

  if (sent > 0) logger.info('Feedback requests dispatched', { orgId, sent })
  return sent
}
