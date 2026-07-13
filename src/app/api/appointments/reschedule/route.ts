import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { z } from 'zod'
import { applyDistributedRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import {
  generateAvailableSlots,
  type BookingConfig,
  type ExistingAppointment,
  formatTimeDisplay,
} from '@/lib/booking/availability'
import { fetchEhrBusyAsAppointments } from '@/lib/booking/ehr-busy'
import { zonedTimeToUtc } from '@/lib/booking/timezone'
import { decodeAppointmentToken } from '@/lib/appointments/token'
import { syncAppointmentToEhr } from '@/lib/booking/ehr-sync'
import { getBrandingForOrg } from '@/lib/branding/store'
import { resolveBrandForContext } from '@/lib/branding/resolve-brand'
import { renderVisitLogistics } from '@/lib/branding/visit-logistics'
import { decryptField } from '@/lib/encryption'
import { sendSMS } from '@/lib/messaging/twilio'
import { sendEmail } from '@/lib/messaging/resend'
import { escapeHtml } from '@/lib/utils'

// An appointment can be self-rescheduled only while it is still upcoming.
// Completed / no-show / canceled rows are terminal; a held-card slot isn't a
// real booking yet.
const RESCHEDULABLE = ['scheduled', 'confirmed'] as const

type BookingSettingsRow = {
  weekly_schedule: BookingConfig['weekly_schedule']
  slot_duration_minutes: number
  buffer_minutes: number
  advance_days: number
  min_notice_hours: number
  blocked_dates: string[] | null
  timezone: string
  max_bookings_per_slot: number | null
  is_enabled: boolean
  location: string | null
  booking_message: string | null
}

/**
 * Load + validate the token, the appointment, and the org's booking config.
 * Returns a typed error string (for the caller to surface) or the loaded rows.
 * NOTE: reschedule is intentionally gated on `is_enabled` (availability is
 * configured) but NOT on `public_booking_enabled` — a phone-first practice that
 * hides the public "book" widget still lets an already-booked patient move their
 * own appointment.
 */
async function loadContext(
  supabase: ReturnType<typeof createServiceClient>,
  token: string | null,
) {
  const decoded = decodeAppointmentToken(token)
  if (!decoded.ok) return { error: decoded.reason } as const

  const { appointmentId, orgId } = decoded.token

  const { data: appt } = await supabase
    .from('appointments')
    .select('id, organization_id, lead_id, scheduled_at, duration_minutes, status, carestack_appointment_id')
    .eq('id', appointmentId)
    .eq('organization_id', orgId)
    .maybeSingle()

  if (!appt) return { error: 'not_found' } as const
  if (!RESCHEDULABLE.includes(appt.status as (typeof RESCHEDULABLE)[number])) {
    return { error: 'not_reschedulable' } as const
  }

  const { data: settings } = await supabase
    .from('booking_settings')
    .select('*')
    .eq('organization_id', orgId)
    .single()

  if (!settings || !settings.is_enabled) return { error: 'unavailable' } as const

  return { appt, settings: settings as unknown as BookingSettingsRow, orgId } as const
}

/**
 * Build the available-slot list for this org, excluding the appointment being
 * moved from the "busy" set so its own current time doesn't block a same-window
 * reschedule.
 */
async function buildSlots(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
  settings: BookingSettingsRow,
  excludeAppointmentId: string,
) {
  const now = new Date()
  const futureDate = new Date(now.getTime() + settings.advance_days * 24 * 60 * 60 * 1000)

  const { data: appts } = await supabase
    .from('appointments')
    .select('id, scheduled_at, duration_minutes, status')
    .eq('organization_id', orgId)
    .gte('scheduled_at', now.toISOString())
    .lte('scheduled_at', futureDate.toISOString())
    .not('status', 'eq', 'canceled')

  const busy = ((appts || []) as (ExistingAppointment & { id: string })[])
    .filter((a) => a.id !== excludeAppointmentId)

  const config: BookingConfig = {
    weekly_schedule: settings.weekly_schedule,
    slot_duration_minutes: settings.slot_duration_minutes,
    buffer_minutes: settings.buffer_minutes,
    advance_days: settings.advance_days,
    min_notice_hours: settings.min_notice_hours,
    blocked_dates: settings.blocked_dates || [],
    timezone: settings.timezone,
    max_bookings_per_slot: settings.max_bookings_per_slot || 1,
  }

  const ehrBusy = await fetchEhrBusyAsAppointments(supabase, orgId, settings.advance_days)
  return { slots: generateAvailableSlots(config, [...busy, ...ehrBusy]), config }
}

// ═══════════════════════════════════════════════════════════════
// GET — reschedule context + available slots (drives the calendar UI)
// ═══════════════════════════════════════════════════════════════
export async function GET(request: NextRequest) {
  const rlError = await applyDistributedRateLimit(request, RATE_LIMITS.publicForm, 'reschedule-slots')
  if (rlError) return rlError

  const token = new URL(request.url).searchParams.get('token')
  const supabase = createServiceClient()

  const ctx = await loadContext(supabase, token)
  if ('error' in ctx) {
    const status = ctx.error === 'expired' || ctx.error === 'invalid' ? 410 : 404
    return NextResponse.json({ error: ctx.error }, { status })
  }

  const { appt, settings, orgId } = ctx

  const { data: org } = await supabase
    .from('organizations')
    .select('name, phone, logo_url')
    .eq('id', orgId)
    .single()

  const { slots } = await buildSlots(supabase, orgId, settings, appt.id)

  return NextResponse.json({
    organization: {
      name: org?.name ?? 'Our Practice',
      phone: org?.phone ?? null,
      // booking_settings.location is the display string; organizations.address
      // is a structured JSON object and must not be rendered directly.
      location: settings.location ?? null,
      logo_url: org?.logo_url ?? null,
    },
    settings: {
      slot_duration_minutes: settings.slot_duration_minutes,
      timezone: settings.timezone,
      booking_message: settings.booking_message,
    },
    current: { scheduled_at: appt.scheduled_at },
    slots,
  })
}

// ═══════════════════════════════════════════════════════════════
// POST — move the appointment to the chosen slot
// ═══════════════════════════════════════════════════════════════
const rescheduleSchema = z.object({
  token: z.string().min(1),
  slot_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slot_time: z.string().regex(/^\d{2}:\d{2}$/),
})

export async function POST(request: NextRequest) {
  const rlError = await applyDistributedRateLimit(request, RATE_LIMITS.publicForm, 'reschedule')
  if (rlError) return rlError

  const supabase = createServiceClient()
  const parsed = rescheduleSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
  const { token, slot_date, slot_time } = parsed.data

  const ctx = await loadContext(supabase, token)
  if ('error' in ctx) {
    const status = ctx.error === 'expired' || ctx.error === 'invalid' ? 410 : 404
    return NextResponse.json({ error: ctx.error }, { status })
  }
  const { appt, settings, orgId } = ctx

  // Re-verify the slot is still open (excluding this appointment's own time).
  const { slots } = await buildSlots(supabase, orgId, settings, appt.id)
  const daySlots = slots.find((d) => d.date === slot_date)
  if (!daySlots || !daySlots.times.includes(slot_time)) {
    return NextResponse.json(
      { error: 'That time was just taken. Please pick another.' },
      { status: 409 },
    )
  }

  const newScheduledAt = zonedTimeToUtc(slot_date, slot_time, settings.timezone).toISOString()

  // Move the SAME appointment row. Confirming a new time also re-confirms
  // attendance, so we clear the reschedule flag and reset the risk score. The
  // card on file (if any) is untouched — no charge, it still only fires on a
  // real no-show of the NEW time.
  const { error: updateError } = await supabase
    .from('appointments')
    .update({
      scheduled_at: newScheduledAt,
      status: 'confirmed',
      reschedule_requested: false,
      confirmation_received: true,
      confirmed_via: 'reschedule_link',
      confirmed_at: new Date().toISOString(),
      no_show_risk_score: 0,
    })
    .eq('id', appt.id)
    .eq('organization_id', orgId)

  if (updateError) {
    if (updateError.code === '23505') {
      return NextResponse.json(
        { error: 'That time was just taken. Please pick another.' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: 'Failed to reschedule' }, { status: 500 })
  }

  // Keep the lead's consultation_date in sync with the moved appointment.
  await supabase
    .from('leads')
    .update({ consultation_date: newScheduledAt })
    .eq('id', appt.lead_id)
    .eq('organization_id', orgId)

  await supabase.from('lead_activities').insert({
    organization_id: orgId,
    lead_id: appt.lead_id,
    activity_type: 'appointment_rescheduled',
    title: 'Patient rescheduled via reminder link',
    description: `Moved to ${slot_date} ${slot_time}`,
    metadata: {
      appointment_id: appt.id,
      previous_scheduled_at: appt.scheduled_at,
      new_scheduled_at: newScheduledAt,
      source: 'reschedule_link',
    },
  })

  // EHR resync (fire-and-forget, never blocks the patient). A CareStack move is
  // a cancel-of-old + book-of-new; the new scheduled_at is already persisted, so
  // clearing the old id lets the (idempotent) book leg re-create at the new time.
  if (appt.carestack_appointment_id) {
    void (async () => {
      await syncAppointmentToEhr(supabase, appt.id, { action: 'cancel', reasonCode: 'rescheduled' })
      await supabase.from('appointments').update({ carestack_appointment_id: null }).eq('id', appt.id)
      await syncAppointmentToEhr(supabase, appt.id, { action: 'book' })
    })()
  } else {
    void syncAppointmentToEhr(supabase, appt.id, { action: 'book' })
  }

  // Send new-time confirmation, brand-aware (same resolver the booking path uses).
  void sendRescheduleConfirmation(supabase, orgId, appt.lead_id, newScheduledAt, settings)

  return NextResponse.json({ success: true, scheduled_at: newScheduledAt })
}

/**
 * Best-effort SMS + email confirming the new time. Mirrors the booking path's
 * brand/logistics resolution so a TMJ lead hears the TMJ brand, etc.
 */
async function sendRescheduleConfirmation(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
  leadId: string,
  scheduledAt: string,
  settings: BookingSettingsRow,
) {
  try {
    const { data: lead } = await supabase
      .from('leads')
      .select('first_name, phone, email, tags, custom_fields, utm_campaign, utm_source, campaign_attribution')
      .eq('id', leadId)
      .maybeSingle()
    if (!lead) return

    const firstName = decryptField(lead.first_name as string) || 'there'
    const phone = decryptField(lead.phone as string)
    const email = decryptField(lead.email as string)

    const { branding, orgName: orgDisplayName } = await getBrandingForOrg(supabase, orgId)
    const brand = resolveBrandForContext(branding, orgDisplayName, { lead: lead as never })
    const orgName = brand.practiceName
    const logistics = renderVisitLogistics(brand)

    const dateDisplay = new Date(scheduledAt).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', timeZone: settings.timezone,
    })
    const timeDisplay = formatTimeDisplay(
      new Date(scheduledAt).toLocaleTimeString('en-US', {
        hour12: false, hour: '2-digit', minute: '2-digit', timeZone: settings.timezone,
      }),
    )

    if (phone) {
      try {
        await sendSMS(
          phone,
          `Hi ${firstName}! Your appointment at ${orgName} has been rescheduled to ${dateDisplay} at ${timeDisplay}.${logistics.smsSuffix ? ` ${logistics.smsSuffix}` : ''} See you then! Reply STOP to opt out.`,
        )
      } catch { /* non-fatal — the move already succeeded */ }
    }

    if (email) {
      try {
        await sendEmail({
          to: email,
          subject: `Appointment Rescheduled — ${escapeHtml(orgName)}`,
          html: `
            <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
              <h2 style="color: #111;">Your Appointment Has Been Rescheduled</h2>
              <p>Hi ${escapeHtml(firstName)},</p>
              <p>You're all set — your new appointment at <strong>${escapeHtml(orgName)}</strong> is:</p>
              <div style="background: #f9f9f9; padding: 16px; border-radius: 8px; margin: 20px 0;">
                <p style="margin: 4px 0;"><strong>Date:</strong> ${escapeHtml(dateDisplay)}</p>
                <p style="margin: 4px 0;"><strong>Time:</strong> ${escapeHtml(timeDisplay)}</p>
                ${settings.location ? `<p style="margin: 4px 0;"><strong>Location:</strong> ${escapeHtml(settings.location)}</p>` : ''}
              </div>
              ${logistics.emailHtml}
              <p style="color: #666; font-size: 12px; margin-top: 24px;">Need to change it again? Reply to this email or call us.</p>
            </div>
          `,
          text: `Hi ${firstName}, your appointment at ${orgName} has been rescheduled to ${dateDisplay} at ${timeDisplay}.${logistics.emailText ? `\n\n${logistics.emailText}` : ''}`,
        })
      } catch { /* non-fatal */ }
    }
  } catch {
    // Confirmation is best-effort; the reschedule itself already committed.
  }
}
