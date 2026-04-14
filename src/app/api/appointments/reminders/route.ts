import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/appointments/reminders?appointment_id=xxx
 *
 * Get the reminder history for an appointment.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { searchParams } = new URL(request.url)
  const appointmentId = searchParams.get('appointment_id')

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let query = supabase
    .from('appointment_reminders')
    .select('*')
    .eq('organization_id', profile.organization_id)
    .order('created_at', { ascending: true })

  if (appointmentId) {
    query = query.eq('appointment_id', appointmentId)
  }

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ reminders: data })
}

/**
 * POST /api/appointments/reminders
 *
 * Manually trigger a reminder for a specific appointment.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const body = await request.json()

  const { appointment_id, channel } = body

  if (!appointment_id) {
    return NextResponse.json({ error: 'appointment_id is required' }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get appointment with lead
  const { data: apt } = await supabase
    .from('appointments')
    .select('*, lead:leads(id, first_name, last_name, phone, email)')
    .eq('id', appointment_id)
    .eq('organization_id', profile.organization_id)
    .single()

  if (!apt) {
    return NextResponse.json({ error: 'Appointment not found' }, { status: 404 })
  }

  const lead = apt.lead as any
  if (!lead) {
    return NextResponse.json({ error: 'Lead not found for appointment' }, { status: 404 })
  }

  // Get org name
  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', profile.organization_id)
    .single()

  const practiceName = org?.name || 'our office'

  const dateTime = new Date(apt.scheduled_at).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  const results: Array<{ channel: string; status: string; detail?: string }> = []

  // Send SMS reminder
  if ((!channel || channel === 'sms') && lead.phone) {
    try {
      const { sendSMS } = await import('@/lib/messaging/twilio')
      const smsBody = `Hi ${lead.first_name || 'there'}! Reminder: your ${apt.type} at ${practiceName} is scheduled for ${dateTime}. Reply YES to confirm or call us to reschedule.`

      const result = await sendSMS(lead.phone, smsBody)

      await supabase.from('appointment_reminders').insert({
        organization_id: profile.organization_id,
        appointment_id,
        lead_id: lead.id,
        channel: 'sms',
        reminder_type: 'manual',
        status: 'sent',
        sent_at: new Date().toISOString(),
        external_id: result.sid,
      })

      results.push({ channel: 'sms', status: 'sent' })
    } catch (err) {
      results.push({ channel: 'sms', status: 'error', detail: err instanceof Error ? err.message : 'unknown' })
    }
  }

  // Send email reminder
  if ((!channel || channel === 'email') && lead.email) {
    try {
      const { sendEmail } = await import('@/lib/messaging/resend')
      const { generate24hEmailTemplate, getConfirmationUrl, getRescheduleUrl } = await import('@/lib/campaigns/reminder-templates')

      const template = generate24hEmailTemplate({
        firstName: lead.first_name || 'there',
        appointmentType: apt.type,
        dateTime,
        location: apt.location,
        practiceName,
        confirmUrl: getConfirmationUrl(appointment_id, profile.organization_id),
        rescheduleUrl: getRescheduleUrl(appointment_id, profile.organization_id),
      })

      const result = await sendEmail({
        to: lead.email,
        subject: template.subject,
        html: template.html,
        text: template.text,
      })

      await supabase.from('appointment_reminders').insert({
        organization_id: profile.organization_id,
        appointment_id,
        lead_id: lead.id,
        channel: 'email',
        reminder_type: 'manual',
        status: 'sent',
        sent_at: new Date().toISOString(),
        external_id: result.id,
      })

      results.push({ channel: 'email', status: 'sent' })
    } catch (err) {
      results.push({ channel: 'email', status: 'error', detail: err instanceof Error ? err.message : 'unknown' })
    }
  }

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: profile.organization_id,
    lead_id: lead.id,
    user_id: profile.id,
    activity_type: 'manual_reminder_sent',
    title: `Manual reminder sent (${results.map(r => r.channel).join(', ')})`,
    metadata: { appointment_id, results },
  })

  return NextResponse.json({ results })
}
