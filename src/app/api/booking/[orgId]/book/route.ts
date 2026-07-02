import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { z } from 'zod'
import { applyDistributedRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { sendSMS } from '@/lib/messaging/twilio'
import { sendEmail } from '@/lib/messaging/resend'
import { generateAvailableSlots, type BookingConfig, type ExistingAppointment, formatTimeDisplay } from '@/lib/booking/availability'
import { zonedTimeToUtc } from '@/lib/booking/timezone'
import { encryptLeadPII } from '@/lib/encryption'
import { sendCardCaptureLink } from '@/lib/stripe/no-show-fee'
import { escapeHtml } from '@/lib/utils'
import { syncAppointmentToEhr } from '@/lib/booking/ehr-sync'
import { fetchEhrBusyAsAppointments } from '@/lib/booking/ehr-busy'

const bookingSchema = z.object({
  slot_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slot_time: z.string().regex(/^\d{2}:\d{2}$/),
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  phone: z.string().min(10).max(20),
  email: z.string().email(),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().max(500).optional(),
  // Explicit marketing opt-in checkbox. Absent/false → no marketing consent is
  // granted (the booking confirmation itself is transactional and still sends).
  marketing_consent: z.boolean().optional(),
})

// POST /api/booking/[orgId]/book — Public: book an appointment
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  const rlError = await applyDistributedRateLimit(request, RATE_LIMITS.publicForm, 'booking')
  if (rlError) return rlError

  const { orgId } = await params
  const supabase = createServiceClient()

  const body = await request.json()
  const parsed = bookingSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const { slot_date, slot_time, first_name, last_name, phone, email, date_of_birth, notes, marketing_consent } = parsed.data
  const grantConsent = marketing_consent === true

  // Get booking settings
  const { data: settings } = await supabase
    .from('booking_settings')
    .select('*')
    .eq('organization_id', orgId)
    .single()

  // Public widget requires BOTH the master switch and the public opt-in.
  if (!settings || !settings.is_enabled || !settings.public_booking_enabled) {
    return NextResponse.json({ error: 'Booking is not available' }, { status: 404 })
  }

  // Phone-first gate: when the practice books by phone, the public widget must
  // NOT self-confirm a consultation. Capture the lead + their preferred time as
  // a call request; staff will call to qualify and book.
  if (settings.require_call_before_booking) {
    const { data: gateOrg } = await supabase.from('organizations').select('name').eq('id', orgId).single()
    const gateOrgName = gateOrg?.name || 'Our Practice'

    // Never overwrite an existing lead's identity or consent from this
    // unauthenticated route (same safety rule as the booking path below).
    const { data: existing } = await supabase
      .from('leads').select('id').eq('organization_id', orgId).eq('email', email).limit(1).single()

    let requestLeadId: string
    if (existing) {
      requestLeadId = existing.id
    } else {
      const newLeadConsent = grantConsent
        ? {
            sms_consent: true, sms_consent_at: new Date().toISOString(), sms_consent_source: 'booking_form',
            email_consent: true, email_consent_at: new Date().toISOString(), email_consent_source: 'booking_form',
          }
        : {}
      const { data: newLead, error: newLeadErr } = await supabase
        .from('leads')
        .insert(encryptLeadPII({
          organization_id: orgId, first_name, last_name, phone, email,
          date_of_birth: date_of_birth ?? null,
          source_type: 'booking_page', status: 'new', ...newLeadConsent,
        }))
        .select('id').single()
      if (newLeadErr || !newLead) return NextResponse.json({ error: 'Failed to create lead' }, { status: 500 })
      requestLeadId = newLead.id
    }

    await supabase.from('lead_activities').insert({
      organization_id: orgId,
      lead_id: requestLeadId,
      activity_type: 'call_requested',
      title: 'Consultation call requested via booking page',
      description: `Preferred time: ${slot_date} ${slot_time}`,
      metadata: { source: 'booking_page', preferred_date: slot_date, preferred_time: slot_time },
    })

    try {
      await sendSMS(phone, `Hi ${first_name}! Thanks for reaching out to ${gateOrgName}. A coordinator will call you shortly to go over your options and get your consultation booked. Reply STOP to opt out.`)
    } catch {
      // Non-fatal: the lead + call request are already recorded for staff follow-up.
    }

    return NextResponse.json({
      success: true,
      call_requested: true,
      message: 'Thanks! A coordinator will call you shortly to confirm your consultation.',
    }, { status: 200 })
  }

  // Verify the slot is still available (atomic check). Store the absolute UTC
  // instant for the practice-local (date, time) — the column is timestamptz.
  const scheduledAt = zonedTimeToUtc(slot_date, slot_time, settings.timezone).toISOString()
  const now = new Date()
  const futureDate = new Date(now.getTime() + settings.advance_days * 24 * 60 * 60 * 1000)

  const { data: existingAppts } = await supabase
    .from('appointments')
    .select('scheduled_at, duration_minutes, status')
    .eq('organization_id', orgId)
    .gte('scheduled_at', now.toISOString())
    .lte('scheduled_at', futureDate.toISOString())
    .not('status', 'eq', 'canceled')

  const config: BookingConfig = {
    weekly_schedule: settings.weekly_schedule as BookingConfig['weekly_schedule'],
    slot_duration_minutes: settings.slot_duration_minutes,
    buffer_minutes: settings.buffer_minutes,
    advance_days: settings.advance_days,
    min_notice_hours: settings.min_notice_hours,
    blocked_dates: settings.blocked_dates || [],
    timezone: settings.timezone,
    max_bookings_per_slot: settings.max_bookings_per_slot || 1,
  }

  const ehrBusy = await fetchEhrBusyAsAppointments(supabase, orgId, settings.advance_days)
  const availableSlots = generateAvailableSlots(config, [...((existingAppts || []) as ExistingAppointment[]), ...ehrBusy])
  const daySlots = availableSlots.find((d) => d.date === slot_date)
  if (!daySlots || !daySlots.times.includes(slot_time)) {
    return NextResponse.json({ error: 'This time slot is no longer available. Please select another time.' }, { status: 409 })
  }

  // Get org info
  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .single()
  const orgName = org?.name || 'Our Practice'

  // Find or create lead
  let leadId: string
  const { data: existingLead } = await supabase
    .from('leads')
    .select('id')
    .eq('organization_id', orgId)
    .eq('email', email)
    .limit(1)
    .single()

  // Only grant marketing consent when the booker explicitly opted in. NEVER
  // overwrite an existing lead's consent from this unauthenticated path (that
  // would let anyone un-revoke a prior opt-out by booking with the victim's email).
  const consentFields = grantConsent
    ? {
        sms_consent: true,
        sms_consent_at: new Date().toISOString(),
        sms_consent_source: 'booking_form',
        email_consent: true,
        email_consent_at: new Date().toISOString(),
        email_consent_source: 'booking_form',
      }
    : {}

  if (existingLead) {
    leadId = existingLead.id
    // Existing lead: attach the appointment only. We deliberately do NOT
    // overwrite identity fields (first/last/phone) from this unauthenticated
    // path — knowing a victim's email + the public orgId would otherwise let
    // anyone rewrite that lead's phone (the SMS destination) or name. Identity
    // edits require an authenticated staff session. Consent is likewise untouched.
    await supabase.from('leads').update({
      status: 'consultation_scheduled',
      consultation_date: scheduledAt,
    }).eq('id', leadId)
  } else {
    const { data: newLead, error: leadError } = await supabase
      .from('leads')
      .insert(encryptLeadPII({
        organization_id: orgId,
        first_name,
        last_name,
        phone,
        email,
        date_of_birth: date_of_birth ?? null,
        source_type: 'booking_page',
        status: 'consultation_scheduled',
        consultation_date: scheduledAt,
        ...consentFields,
      }))
      .select('id')
      .single()

    if (leadError || !newLead) {
      return NextResponse.json({ error: 'Failed to create lead' }, { status: 500 })
    }
    leadId = newLead.id
  }

  // Create appointment
  const { data: appointment, error: apptError } = await supabase
    .from('appointments')
    .insert({
      organization_id: orgId,
      lead_id: leadId,
      type: 'consultation',
      scheduled_at: scheduledAt,
      duration_minutes: settings.slot_duration_minutes,
      location: settings.location || null,
      notes: notes || null,
      status: 'scheduled',
      booked_via: 'public',
      no_show_fee_cents: settings.no_show_fee_enabled ? settings.no_show_fee_cents : null,
    })
    .select('id')
    .single()

  if (apptError) {
    // Handle unique constraint violation (double-booking)
    if (apptError.code === '23505') {
      return NextResponse.json({ error: 'This time slot was just booked by someone else. Please select another time.' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Failed to create appointment' }, { status: 500 })
  }
  if (!appointment) {
    return NextResponse.json({ error: 'Failed to create appointment' }, { status: 500 })
  }

  // Fire-and-forget: push to CareStack + Dion Clinical + Slack. Never blocks the booking.
  void syncAppointmentToEhr(supabase, appointment.id, { action: 'book' })

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: orgId,
    lead_id: leadId,
    activity_type: 'appointment_scheduled',
    title: `Self-booked consultation for ${new Date(scheduledAt).toLocaleDateString('en-US', { timeZone: settings.timezone })}`,
    metadata: { appointment_id: appointment.id, source: 'booking_page' },
  })

  // Send confirmation SMS
  const timeDisplay = formatTimeDisplay(slot_time)
  const dateDisplay = new Date(scheduledAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: settings.timezone })

  try {
    await sendSMS(phone, `Hi ${first_name}! Your consultation at ${orgName} is confirmed for ${dateDisplay} at ${timeDisplay}. We look forward to seeing you! Reply STOP to opt out.`)
  } catch (err) {
    // Log SMS failure for visibility
    await supabase.from('lead_activities').insert({
      organization_id: orgId,
      lead_id: leadId,
      activity_type: 'notification_failed',
      title: 'Booking confirmation SMS failed',
      metadata: { error: err instanceof Error ? err.message : 'unknown', channel: 'sms' },
    })
  }

  // Send confirmation email
  try {
    await sendEmail({
      to: email,
      subject: `Consultation Confirmed — ${escapeHtml(orgName)}`,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #111;">Your Consultation is Confirmed!</h2>
          <p>Hi ${escapeHtml(first_name)},</p>
          <p>You're all set for your consultation at <strong>${escapeHtml(orgName)}</strong>.</p>
          <div style="background: #f9f9f9; padding: 16px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 4px 0;"><strong>Date:</strong> ${escapeHtml(dateDisplay)}</p>
            <p style="margin: 4px 0;"><strong>Time:</strong> ${escapeHtml(timeDisplay)}</p>
            <p style="margin: 4px 0;"><strong>Duration:</strong> ${settings.slot_duration_minutes} minutes</p>
            ${settings.location ? `<p style="margin: 4px 0;"><strong>Location:</strong> ${escapeHtml(settings.location)}</p>` : ''}
          </div>
          <p>${escapeHtml(settings.booking_message || 'We look forward to seeing you!')}</p>
          <p style="color: #666; font-size: 12px; margin-top: 24px;">
            Need to reschedule? Reply to this email or call us.
          </p>
        </div>
      `,
      text: `Hi ${first_name}, your consultation at ${orgName} is confirmed for ${dateDisplay} at ${timeDisplay}. ${settings.location ? `Location: ${settings.location}. ` : ''}We look forward to seeing you!`,
    })
  } catch (err) {
    // Log email failure for visibility
    await supabase.from('lead_activities').insert({
      organization_id: orgId,
      lead_id: leadId,
      activity_type: 'notification_failed',
      title: 'Booking confirmation email failed',
      metadata: { error: err instanceof Error ? err.message : 'unknown', channel: 'email' },
    })
  }

  // No-show fee: text the patient a card-on-file link (charged only on no-show).
  if (settings.no_show_fee_enabled) {
    await sendCardCaptureLink(supabase, orgId, {
      appointmentId: appointment.id,
      leadId,
      feeCents: settings.no_show_fee_cents ?? 5000,
      phone,
      email,
      name: `${first_name} ${last_name}`.trim(),
      orgName,
    })
  }

  return NextResponse.json({
    success: true,
    appointment_id: appointment.id,
    scheduled_at: scheduledAt,
    message: settings.booking_message || 'Your consultation has been booked!',
  }, { status: 201 })
}
