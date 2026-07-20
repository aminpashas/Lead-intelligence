/**
 * Tiered no-show escalation — runs as a pass inside the reminders cron.
 *
 * Tier 1 (risk 40–69), ~4h before the visit: AI check-in SMS that requires a
 * reply. Silence for 2h re-arms the 2h AI confirmation call (see the .or()
 * clause in send2hConfirmationCalls) even if the patient "confirmed" days ago.
 *
 * Tier 2 (risk ≥70), day-of: one staff escalation — lead_activities row
 * (drives the At-Risk queue on /appointments) + Slack alert via the connector
 * dispatcher. Fires at most once per appointment.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { dispatchConnectorEvent } from '@/lib/connectors/dispatcher'
import { RISK_TIER1, RISK_TIER2 } from './attendance-risk'
import type { BrandNameResolver, ReminderResult } from './reminders'
import { zonedTimeLabel } from '@/lib/time/zoned'
import { logger } from '@/lib/logger'

type EscalationAppointment = {
  id: string
  lead_id: string
  scheduled_at: string
  no_show_risk_score: number
  checkin_sent_at: string | null
  escalated_at: string | null
  lead: {
    id: string
    first_name: string | null
    last_name: string | null
    phone: string | null
    email: string | null
    source_type: string | null
    no_show_count: number | null
    sms_opt_out: boolean
  } | null
}

/**
 * The brand-resolution fields (tags / utm_* / campaign_attribution /
 * landing_page_url / custom_fields) are what `brandNameFor` reads to pick the
 * right DBA. Omitting them silently falls back to the org display name, so a
 * patient booked under "Dion Health" would get checked in on by "SF Dentistry".
 *
 * `sms_consent` is deliberately NOT selected: this app's consent model is
 * opt-out-only (see CLAUDE.md), and the gate below is `sms_opt_out` alone.
 */
const APPT_SELECT =
  'id, lead_id, scheduled_at, no_show_risk_score, checkin_sent_at, escalated_at, ' +
  'lead:leads(id, first_name, last_name, phone, email, source_type, no_show_count, sms_opt_out, ' +
  'tags, utm_campaign, utm_source, campaign_attribution, landing_page_url, custom_fields)'

/**
 * Appointment time in the PRACTICE's zone, not the server's.
 *
 * Vercel runs UTC, so a bare `toLocaleString` renders an 11 AM Pacific consult
 * as "6 PM" — the exact bug the reminder tiers were fixed for. Every patient-
 * facing time in this module goes through here.
 */
export function formatEscalationTime(iso: string, timeZone: string): string {
  return zonedTimeLabel(new Date(iso), timeZone)
}

/** Tier-1 morning-of check-in SMS body — reply-required, YES to confirm. */
export function buildCheckinSmsBody(params: {
  firstName: string | null
  practiceName: string
  scheduledAt: string
  timeZone: string
}): string {
  return `Hi ${params.firstName || 'there'}, quick check-in from ${params.practiceName} — will we see you at ${formatEscalationTime(params.scheduledAt, params.timeZone)} today? Reply YES to confirm, or reply here if you need to reschedule.`
}

export async function runAttendanceEscalation(
  supabase: SupabaseClient,
  orgId: string,
  brandNameFor: BrandNameResolver,
  now: Date,
  timeZone: string
): Promise<ReminderResult[]> {
  const results: ReminderResult[] = []

  // ── Tier 1: morning-of check-in, window 3.5–4.5h before the visit ──
  const t1From = new Date(now.getTime() + 3.5 * 60 * 60 * 1000)
  const t1To = new Date(now.getTime() + 4.5 * 60 * 60 * 1000)

  const { data: tier1 } = await supabase
    .from('appointments')
    .select(APPT_SELECT)
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed'])
    .is('checkin_sent_at', null)
    .gte('no_show_risk_score', RISK_TIER1)
    .lt('no_show_risk_score', RISK_TIER2)
    .gte('scheduled_at', t1From.toISOString())
    .lte('scheduled_at', t1To.toISOString())

  for (const apt of (tier1 || []) as unknown as EscalationAppointment[]) {
    const lead = apt.lead
    if (!lead?.phone || lead.sms_opt_out) {
      results.push({ appointment_id: apt.id, type: 'checkin_4h', channel: 'sms', status: 'skipped', detail: 'no_phone_or_opted_out' })
      continue
    }
    const body = buildCheckinSmsBody({
      firstName: lead.first_name,
      practiceName: brandNameFor(lead),
      scheduledAt: apt.scheduled_at,
      timeZone,
    })
    try {
      const sendRes = await sendSMSToLead({ supabase, leadId: lead.id, to: lead.phone, body, caller: 'escalation.checkin_4h' })
      if (!sendRes.sent) {
        results.push({ appointment_id: apt.id, type: 'checkin_4h', channel: 'sms', status: 'skipped', detail: `consent:${sendRes.reason}` })
        continue
      }
      await supabase.from('appointment_reminders').insert({
        organization_id: orgId,
        appointment_id: apt.id,
        lead_id: lead.id,
        channel: 'sms',
        reminder_type: 'checkin_4h',
        status: 'sent',
        sent_at: new Date().toISOString(),
        external_id: sendRes.sid,
      })
      await supabase
        .from('appointments')
        .update({ checkin_sent_at: new Date().toISOString(), escalation_tier: 1 })
        .eq('id', apt.id)
      results.push({ appointment_id: apt.id, type: 'checkin_4h', channel: 'sms', status: 'sent' })
    } catch (err) {
      logger.error('tier-1 check-in failed', { appointment_id: apt.id, error: err instanceof Error ? err.message : String(err) })
      results.push({ appointment_id: apt.id, type: 'checkin_4h', channel: 'sms', status: 'error', detail: err instanceof Error ? err.message : 'unknown' })
    }
  }

  // ── Tier 2: staff escalation, day-of (within 8h), once per appointment ──
  const t2To = new Date(now.getTime() + 8 * 60 * 60 * 1000)

  const { data: tier2 } = await supabase
    .from('appointments')
    .select(APPT_SELECT)
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed'])
    .is('escalated_at', null)
    .gte('no_show_risk_score', RISK_TIER2)
    .gte('scheduled_at', now.toISOString())
    .lte('scheduled_at', t2To.toISOString())

  for (const apt of (tier2 || []) as unknown as EscalationAppointment[]) {
    const lead = apt.lead
    if (!lead) continue
    try {
      // activity_type must stay inside the CHECK whitelist
      // (supabase/migrations/002_leads_and_pipeline.sql) — the machine-readable
      // kind lives in metadata.kind; Task 7 reads escalation_tier off appointments.
      await supabase.from('lead_activities').insert({
        organization_id: orgId,
        lead_id: lead.id,
        activity_type: 'note_added',
        title: `High no-show risk (${apt.no_show_risk_score}) — personal call recommended before ${formatEscalationTime(apt.scheduled_at, timeZone)}`,
        metadata: {
          automated: true,
          kind: 'attendance_escalated',
          appointment_id: apt.id,
          risk: apt.no_show_risk_score,
          prior_no_shows: lead.no_show_count ?? 0,
        },
      })

      // Slack only — ad connectors are filtered out before any network call.
      await dispatchConnectorEvent(
        supabase,
        {
          type: 'appointment.at_risk',
          organizationId: orgId,
          leadId: lead.id,
          timestamp: new Date().toISOString(),
          data: {
            lead: {
              id: lead.id,
              firstName: lead.first_name || 'Unknown',
              lastName: lead.last_name || '',
              phone: lead.phone,
              email: lead.email,
              source_type: lead.source_type,
            },
            metadata: {
              appointment_time: formatEscalationTime(apt.scheduled_at, timeZone),
              risk_score: apt.no_show_risk_score,
              prior_no_shows: lead.no_show_count ?? 0,
            },
          },
        },
        { only: ['slack'] }
      )

      await supabase
        .from('appointments')
        .update({ escalated_at: new Date().toISOString(), escalation_tier: 2 })
        .eq('id', apt.id)

      results.push({ appointment_id: apt.id, type: 'escalation', channel: 'slack', status: 'sent' })
    } catch (err) {
      logger.error('tier-2 escalation failed', { appointment_id: apt.id, error: err instanceof Error ? err.message : String(err) })
      results.push({ appointment_id: apt.id, type: 'escalation', channel: 'slack', status: 'error', detail: err instanceof Error ? err.message : 'unknown' })
    }
  }

  return results
}
