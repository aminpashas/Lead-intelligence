import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { z } from 'zod'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { sendSMS } from '@/lib/messaging/twilio'
import { sendEmail } from '@/lib/messaging/resend'
import { generateAvailableSlots, type BookingConfig, type ExistingAppointment, formatTimeDisplay } from '@/lib/booking/availability'

const bookingSchema = z.object({
  slot_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slot_time: z.string().regex(/^\d{2}:\d{2}$/),
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  phone: z.string().min(10).max(20),
  email: z.string().email(),
  notes: z.string().max(500).optional(),
})

// POST /api/booking/[orgId]/book — Public: book an appointment
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  const rlError = applyRateLimit(request, RATE_LIMITS.publicForm)
  if (rlError) return rlError

  const { orgId } = await params
  const supabase = createServiceClient()

  const body = await request.json()
  const parsed = bookingSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const { slot_date, slot_time, first_name, last_name, phone, email, notes } = parsed.data

  // Get booking settings
  const { data: settings } = await supabase
    .from('booking_settings')
    .select('*')
    .eq('organization_id', orgId)
    .single()

  if (!settings || !settings.is_enabled) {
    return NextResponse.json({ error: 'Booking is not available' }, { status: 404 })
  }

  // Verify the slot is still available (atomic check)
  const scheduledAt = `${slot_date}T${slot_time}:00`
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

  const availableSlots = generateAvailableSlots(config, (existingAppts || []) as ExistingAppointment[])
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

  if (existingLead) {
    leadId = existingLead.id
    // Update lead info
    await supabase.from('leads').update({
      first_name,
      last_name,
      phone,
      status: 'consultation_scheduled',
      consultation_date: scheduledAt,
      sms_consent: true,
      sms_consent_at: new Date().toISOString(),
      sms_consent_source: 'booking_form',
      email_consent: true,
      email_consent_at: new Date().toISOString(),
      email_consent_source: 'booking_form',
    }).eq('id', leadId)
  } else {
    const { data: newLead, error: leadError } = await supabase
      .from('leads')
      .insert({
        organization_id: orgId,
        first_name,
        last_name,
        phone,
        email,
        source_type: 'booking_page',
        status: 'consultation_scheduled',
        consultation_date: scheduledAt,
        sms_consent: true,
        sms_consent_at: new Date().toISOString(),
        sms_consent_source: 'booking_form',
        email_consent: true,
        email_consent_at: new Date().toISOString(),
        email_consent_source: 'booking_form',
      })
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
    })
    .select('id')
    .single()

  if (apptError || !appointment) {
    return NextResponse.json({ error: 'Failed to create appointment' }, { status: 500 })
  }

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: orgId,
    lead_id: leadId,
    activity_type: 'appointment_scheduled',
    title: `Self-booked consultation for ${new Date(scheduledAt).toLocaleDateString()}`,
    metadata: { appointment_id: appointment.id, source: 'booking_page' },
  })

  // Send confirmation SMS
  const timeDisplay = formatTimeDisplay(slot_time)
  const dateDisplay = new Date(scheduledAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  try {
    await sendSMS(phone, `Hi ${first_name}! Your consultation at ${orgName} is confirmed for ${dateDisplay} at ${timeDisplay}. We look forward to seeing you! Reply STOP to opt out.`)
  } catch {
    // SMS failure is non-critical
  }

  // Send confirmation email
  try {
    await sendEmail({
      to: email,
      subject: `Consultation Confirmed — ${orgName}`,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #111;">Your Consultation is Confirmed!</h2>
          <p>Hi ${first_name},</p>
          <p>You're all set for your consultation at <strong>${orgName}</strong>.</p>
          <div style="background: #f9f9f9; padding: 16px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 4px 0;"><strong>Date:</strong> ${dateDisplay}</p>
            <p style="margin: 4px 0;"><strong>Time:</strong> ${timeDisplay}</p>
            <p style="margin: 4px 0;"><strong>Duration:</strong> ${settings.slot_duration_minutes} minutes</p>
            ${settings.location ? `<p style="margin: 4px 0;"><strong>Location:</strong> ${settings.location}</p>` : ''}
          </div>
          <p>${settings.booking_message || 'We look forward to seeing you!'}</p>
          <p style="color: #666; font-size: 12px; margin-top: 24px;">
            Need to reschedule? Reply to this email or call us.
          </p>
        </div>
      `,
      text: `Hi ${first_name}, your consultation at ${orgName} is confirmed for ${dateDisplay} at ${timeDisplay}. ${settings.location ? `Location: ${settings.location}. ` : ''}We look forward to seeing you!`,
    })
  } catch {
    // Email failure is non-critical
  }

  return NextResponse.json({
    success: true,
    appointment_id: appointment.id,
    scheduled_at: scheduledAt,
    message: settings.booking_message || 'Your consultation has been booked!',
  }, { status: 201 })
}
