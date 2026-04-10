import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { generateAvailableSlots, type BookingConfig, type ExistingAppointment } from '@/lib/booking/availability'

// GET /api/booking/[orgId]/slots — Public: get available booking slots
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  const { orgId } = await params
  const supabase = createServiceClient()

  // Get booking settings
  const { data: settings } = await supabase
    .from('booking_settings')
    .select('*')
    .eq('organization_id', orgId)
    .single()

  if (!settings || !settings.is_enabled) {
    return NextResponse.json({ error: 'Booking is not available' }, { status: 404 })
  }

  // Get organization info
  const { data: org } = await supabase
    .from('organizations')
    .select('name, phone, email, address')
    .eq('id', orgId)
    .single()

  if (!org) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
  }

  // Get existing appointments for the booking window
  const now = new Date()
  const futureDate = new Date(now.getTime() + settings.advance_days * 24 * 60 * 60 * 1000)

  const { data: appointments } = await supabase
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

  const slots = generateAvailableSlots(
    config,
    (appointments || []) as ExistingAppointment[]
  )

  return NextResponse.json({
    organization: {
      name: org.name,
      phone: org.phone,
      email: org.email,
      location: settings.location,
    },
    settings: {
      slot_duration_minutes: settings.slot_duration_minutes,
      timezone: settings.timezone,
      booking_message: settings.booking_message,
    },
    slots,
  })
}
