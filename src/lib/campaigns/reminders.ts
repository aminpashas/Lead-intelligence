import { SupabaseClient } from '@supabase/supabase-js'
import { sendSMS } from '@/lib/messaging/twilio'
import { sendEmail } from '@/lib/messaging/resend'

/**
 * Send appointment reminders for upcoming appointments.
 * - 24h reminder: sent 22-26h before appointment
 * - 1h reminder: sent 30min-90min before appointment
 */
export async function sendAppointmentReminders(supabase: SupabaseClient, orgId: string) {
  const now = new Date()
  const results: Array<{ appointment_id: string; type: '24h' | '1h'; status: 'sent' | 'error'; detail?: string }> = []

  // --- 24-hour reminders ---
  const h24From = new Date(now.getTime() + 22 * 60 * 60 * 1000)
  const h24To = new Date(now.getTime() + 26 * 60 * 60 * 1000)

  const { data: due24h } = await supabase
    .from('appointments')
    .select('*, lead:leads(first_name, last_name, phone, email)')
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed'])
    .eq('reminder_sent_24h', false)
    .gte('scheduled_at', h24From.toISOString())
    .lte('scheduled_at', h24To.toISOString())

  // Get org name for messages
  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .single()

  const practiceName = org?.name || 'our office'

  for (const apt of due24h || []) {
    const lead = apt.lead as any
    if (!lead) continue

    const firstName = lead.first_name || 'there'
    const aptDate = new Date(apt.scheduled_at)
    const timeStr = aptDate.toLocaleString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })

    const smsBody = `Hi ${firstName}! 👋 Friendly reminder: your ${apt.type} at ${practiceName} is tomorrow, ${timeStr}. We're excited to see you! Reply YES to confirm or call us to reschedule.`

    try {
      if (lead.phone) {
        await sendSMS(lead.phone, smsBody)
      }
      if (lead.email) {
        await sendEmail({
          to: lead.email,
          subject: `Reminder: Your appointment tomorrow at ${practiceName}`,
          html: `
            <p>Hi ${firstName},</p>
            <p>This is a friendly reminder that your <strong>${apt.type}</strong> appointment at <strong>${practiceName}</strong> is scheduled for:</p>
            <p style="font-size: 18px; font-weight: bold; color: #2563eb;">${timeStr}</p>
            ${apt.location ? `<p><strong>Location:</strong> ${apt.location}</p>` : ''}
            <p>Please reply to this email or call us if you need to reschedule.</p>
            <p>We look forward to seeing you!</p>
            <p>— ${practiceName}</p>
          `,
        })
      }

      await supabase
        .from('appointments')
        .update({ reminder_sent_24h: true })
        .eq('id', apt.id)

      results.push({ appointment_id: apt.id, type: '24h', status: 'sent' })
    } catch (err) {
      results.push({
        appointment_id: apt.id,
        type: '24h',
        status: 'error',
        detail: err instanceof Error ? err.message : 'unknown',
      })
    }
  }

  // --- 1-hour reminders ---
  const h1From = new Date(now.getTime() + 30 * 60 * 1000)
  const h1To = new Date(now.getTime() + 90 * 60 * 1000)

  const { data: due1h } = await supabase
    .from('appointments')
    .select('*, lead:leads(first_name, last_name, phone)')
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed'])
    .eq('reminder_sent_1h', false)
    .gte('scheduled_at', h1From.toISOString())
    .lte('scheduled_at', h1To.toISOString())

  for (const apt of due1h || []) {
    const lead = apt.lead as any
    if (!lead?.phone) continue

    const firstName = lead.first_name || 'there'
    const aptTime = new Date(apt.scheduled_at).toLocaleString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })

    try {
      await sendSMS(
        lead.phone,
        `Hi ${firstName}! Just a heads up — your appointment at ${practiceName} is in about 1 hour (${aptTime}). See you soon! 😊`
      )

      await supabase
        .from('appointments')
        .update({ reminder_sent_1h: true })
        .eq('id', apt.id)

      results.push({ appointment_id: apt.id, type: '1h', status: 'sent' })
    } catch (err) {
      results.push({
        appointment_id: apt.id,
        type: '1h',
        status: 'error',
        detail: err instanceof Error ? err.message : 'unknown',
      })
    }
  }

  return results
}
