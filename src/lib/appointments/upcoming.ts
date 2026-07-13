/**
 * Booking awareness for the AI agents.
 *
 * The setter is the BOOKING agent, and `consultation_scheduled` leads stay
 * routed to it (STAGE_AGENT_MAP). Without an explicit signal that a booking
 * already exists, the setter keeps trying to book — re-checking availability
 * (where the just-booked slot now reads as taken) and offering contradictory
 * times. This module surfaces the patient's real, current appointment so both
 * the system prompt and the booking tools can treat "already booked" as a
 * first-class state instead of an accident of pipeline stage.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { DEFAULT_PRACTICE_TIMEZONE } from '@/lib/time/zoned'

/** Statuses that mean the patient has a LIVE upcoming consultation. */
const ACTIVE_APPOINTMENT_STATUSES = ['scheduled', 'confirmed'] as const

export interface UpcomingAppointment {
  id: string
  scheduled_at: string
  location: string | null
  status: string
  confirmation_received: boolean
}

/**
 * The soonest LIVE (scheduled/confirmed) future appointment for this lead, or
 * null. Canceled/completed/no_show/rescheduled are ignored — only a real,
 * upcoming booking counts as "already booked".
 */
export async function getActiveUpcomingAppointment(
  supabase: SupabaseClient,
  organizationId: string,
  leadId: string,
  now: Date = new Date()
): Promise<UpcomingAppointment | null> {
  const { data } = await supabase
    .from('appointments')
    .select('id, scheduled_at, location, status, confirmation_received')
    .eq('organization_id', organizationId)
    .eq('lead_id', leadId)
    .in('status', ACTIVE_APPOINTMENT_STATUSES as unknown as string[])
    .gte('scheduled_at', now.toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  return (data as UpcomingAppointment | null) ?? null
}

/**
 * Render a UTC instant as a full practice-local slot label, e.g.
 * "Wednesday, July 15 at 10:00 AM". Practice timezone matters here — a naive
 * UTC render is off by hours and would tell the patient the wrong time.
 */
export function formatAppointmentWhen(
  scheduledAtISO: string,
  timezone?: string | null
): string {
  const tz = timezone || DEFAULT_PRACTICE_TIMEZONE
  const instant = new Date(scheduledAtISO)
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(instant)
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  }).format(instant)
  return `${date} at ${time}`
}

/**
 * The strong "already booked — do NOT reschedule" block appended to the setter's
 * system prompt. Returns '' when there is no live upcoming appointment, so the
 * normal booking behavior is untouched for leads who still need to book.
 */
export function buildAlreadyBookedBlock(
  appointment: UpcomingAppointment | null,
  timezone?: string | null,
  opts?: { rescheduleUrl?: string | null }
): string {
  if (!appointment) return ''

  const when = formatAppointmentWhen(appointment.scheduled_at, timezone)
  const where = appointment.location ? ` at ${appointment.location}` : ''

  // If a self-serve reschedule link is available, the agent hands it over in its
  // OWN reply (just paste the URL) — no booking tool, no slot menu, one text.
  const changeInstruction = opts?.rescheduleUrl
    ? `If they explicitly ask to CHANGE, MOVE, or CANCEL the appointment: do NOT offer times or call any booking tool. Instead, paste this self-serve reschedule link into your reply so they can pick a new time themselves: ${opts.rescheduleUrl} — and confirm their CURRENT time (above) back to them.`
    : `If they explicitly ask to CHANGE, MOVE, or CANCEL the appointment: do NOT offer slots yourself. Warmly let them know a coordinator will help them reschedule, and confirm the CURRENT time (above) back to them accurately.`

  return `═══ ⚠️ ALREADY BOOKED — DO NOT RE-SCHEDULE ═══

This patient ALREADY has a confirmed consultation:
📅 ${when}${where}

Their booking is DONE. In this conversation you MUST NOT:
- offer, list, or hint at any new appointment times;
- call check_availability or create_booking;
- imply their appointment is unconfirmed or needs to be re-picked.

Your job now is to answer their questions, build genuine excitement for the visit, and keep them warm. If they simply confirm or say something like "yes"/"either works", treat it as agreement with the EXISTING time above — acknowledge it and confirm that same time back to them; do NOT interpret it as choosing a new slot.

${changeInstruction}`
}
