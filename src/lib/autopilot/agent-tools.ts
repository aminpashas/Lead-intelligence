/**
 * Agent Tools — Function Calling for AI Agents
 *
 * Defines tools that Claude can call during conversations to take
 * real actions: check appointment availability, create bookings,
 * send financing links, etc.
 *
 * These tools are injected into the Anthropic API call as tool definitions.
 * When Claude returns a tool_use block, we execute the tool and continue.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { generateAvailableSlots, formatTimeDisplay, type BookingConfig, type ExistingAppointment } from '@/lib/booking/availability'
import { encryptLeadPII } from '@/lib/encryption'
import { sendSMS } from '@/lib/messaging/twilio'
import { decryptField } from '@/lib/encryption'
import type Anthropic from '@anthropic-ai/sdk'

// ═══════════════════════════════════════════════════════════
// TOOL DEFINITIONS (sent to Claude)
// ═══════════════════════════════════════════════════════════

export const SETTER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'check_availability',
    description: 'Check available appointment slots for the next 2 weeks. Call this when a patient expresses interest in scheduling or asks about availability.',
    input_schema: {
      type: 'object' as const,
      properties: {
        preferred_day: {
          type: 'string',
          description: 'Optional preferred day of week (e.g., "monday", "tuesday"). Leave empty to get all available days.',
        },
      },
      required: [],
    },
  },
  {
    name: 'create_booking',
    description: 'Book a consultation appointment for the patient. Call this after the patient has confirmed a date and time.',
    input_schema: {
      type: 'object' as const,
      properties: {
        date: {
          type: 'string',
          description: 'The appointment date in YYYY-MM-DD format.',
        },
        time: {
          type: 'string',
          description: 'The appointment time in HH:MM format (24-hour).',
        },
      },
      required: ['date', 'time'],
    },
  },
]

export const CLOSER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'check_financing_status',
    description: 'Check the patient\'s financing pre-approval status and available payment options.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'send_financing_link',
    description: 'Send the patient a link to apply for financing. Only call this when they express interest in payment options.',
    input_schema: {
      type: 'object' as const,
      properties: {
        treatment_value: {
          type: 'number',
          description: 'Optional estimated treatment value in dollars.',
        },
      },
      required: [],
    },
  },
]

// ═══════════════════════════════════════════════════════════
// TOOL EXECUTOR
// ═══════════════════════════════════════════════════════════

export type ToolResult = {
  success: boolean
  data: Record<string, unknown>
  message: string // Human-readable summary for the AI
}

/**
 * Execute a tool call from the AI agent.
 */
export async function executeAgentTool(
  supabase: SupabaseClient,
  toolName: string,
  toolInput: Record<string, unknown>,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
  }
): Promise<ToolResult> {
  switch (toolName) {
    case 'check_availability':
      return executeCheckAvailability(supabase, context.organization_id, toolInput.preferred_day as string | undefined)

    case 'create_booking':
      return executeCreateBooking(supabase, context, toolInput.date as string, toolInput.time as string)

    case 'check_financing_status':
      return executeCheckFinancingStatus(supabase, context.lead_id)

    case 'send_financing_link':
      return executeSendFinancingLink(supabase, context, toolInput.treatment_value as number | undefined)

    default:
      return { success: false, data: {}, message: `Unknown tool: ${toolName}` }
  }
}

// ═══════════════════════════════════════════════════════════
// TOOL IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════

async function executeCheckAvailability(
  supabase: SupabaseClient,
  organizationId: string,
  preferredDay?: string
): Promise<ToolResult> {
  // Get booking settings
  const { data: settings } = await supabase
    .from('booking_settings')
    .select('*')
    .eq('organization_id', organizationId)
    .single()

  if (!settings || !settings.is_enabled) {
    return { success: false, data: {}, message: 'Online booking is not currently available. Please have the patient call to schedule.' }
  }

  // Get existing appointments
  const now = new Date()
  const futureDate = new Date(now.getTime() + settings.advance_days * 24 * 60 * 60 * 1000)

  const { data: existingAppts } = await supabase
    .from('appointments')
    .select('scheduled_at, duration_minutes, status')
    .eq('organization_id', organizationId)
    .gte('scheduled_at', now.toISOString())
    .lte('scheduled_at', futureDate.toISOString())
    .not('status', 'eq', 'canceled')

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

  const slots = generateAvailableSlots(config, (existingAppts || []) as ExistingAppointment[])

  // Filter by preferred day if specified
  let filteredSlots = slots
  if (preferredDay) {
    const dayMap: Record<string, number> = {
      sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
      thursday: 4, friday: 5, saturday: 6,
    }
    const dayNum = dayMap[preferredDay.toLowerCase()]
    if (dayNum !== undefined) {
      filteredSlots = slots.filter(s => s.dayOfWeek === dayNum)
    }
  }

  if (filteredSlots.length === 0) {
    return {
      success: true,
      data: { slots: [], duration: settings.slot_duration_minutes },
      message: preferredDay
        ? `No available slots on ${preferredDay}s in the next ${settings.advance_days} days. Other available dates: ${slots.slice(0, 3).map(s => s.dayLabel).join(', ')}.`
        : 'No available appointment slots in the upcoming schedule.',
    }
  }

  // Format for AI consumption
  const slotSummary = filteredSlots.slice(0, 5).map(day => {
    const times = day.times.slice(0, 4).map(t => formatTimeDisplay(t)).join(', ')
    const more = day.times.length > 4 ? ` (+${day.times.length - 4} more)` : ''
    return `${day.dayLabel}: ${times}${more}`
  }).join('\n')

  return {
    success: true,
    data: {
      slots: filteredSlots.slice(0, 5).map(d => ({
        date: d.date,
        dayLabel: d.dayLabel,
        times: d.times.slice(0, 6),
      })),
      duration: settings.slot_duration_minutes,
      location: settings.location || null,
    },
    message: `Available ${settings.slot_duration_minutes}-minute consultation slots:\n${slotSummary}`,
  }
}

async function executeCreateBooking(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
  },
  date: string,
  time: string
): Promise<ToolResult> {
  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return { success: false, data: {}, message: 'Invalid date or time format. Use YYYY-MM-DD for date and HH:MM for time.' }
  }

  // Get booking settings
  const { data: settings } = await supabase
    .from('booking_settings')
    .select('*')
    .eq('organization_id', context.organization_id)
    .single()

  if (!settings) {
    return { success: false, data: {}, message: 'Booking is not available. Please have the patient call to schedule.' }
  }

  const scheduledAt = `${date}T${time}:00`

  // Verify slot is still available
  const now = new Date()
  const futureDate = new Date(now.getTime() + settings.advance_days * 24 * 60 * 60 * 1000)

  const { data: existingAppts } = await supabase
    .from('appointments')
    .select('scheduled_at, duration_minutes, status')
    .eq('organization_id', context.organization_id)
    .gte('scheduled_at', now.toISOString())
    .lte('scheduled_at', futureDate.toISOString())
    .not('status', 'eq', 'canceled')

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

  const availableSlots = generateAvailableSlots(config, (existingAppts || []) as ExistingAppointment[])
  const daySlots = availableSlots.find(d => d.date === date)

  if (!daySlots || !daySlots.times.includes(time)) {
    return {
      success: false,
      data: {},
      message: `The ${formatTimeDisplay(time)} slot on ${date} is no longer available. Please check availability again and offer the patient another time.`,
    }
  }

  // Create the appointment
  const { data: appointment, error } = await supabase
    .from('appointments')
    .insert({
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      type: 'consultation',
      scheduled_at: scheduledAt,
      duration_minutes: settings.slot_duration_minutes,
      location: settings.location || null,
      status: 'scheduled',
      notes: 'Booked via AI agent during conversation',
    })
    .select('id')
    .single()

  if (error) {
    if (error.code === '23505') {
      return { success: false, data: {}, message: 'This slot was just booked by someone else. Please offer the patient another time.' }
    }
    return { success: false, data: {}, message: 'Failed to create the booking. Please try again or have the patient call to schedule.' }
  }

  // Update lead status
  await supabase
    .from('leads')
    .update(encryptLeadPII({
      status: 'consultation_scheduled',
      consultation_date: scheduledAt,
    }))
    .eq('id', context.lead_id)

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: context.organization_id,
    lead_id: context.lead_id,
    activity_type: 'appointment_scheduled',
    title: `AI booked consultation for ${new Date(scheduledAt).toLocaleDateString()}`,
    metadata: {
      appointment_id: appointment!.id,
      source: 'ai_agent',
      conversation_id: context.conversation_id,
    },
  })

  // Send confirmation SMS if patient has phone
  const phone = context.lead.phone_formatted
    ? (decryptField(context.lead.phone_formatted as string) || context.lead.phone_formatted)
    : null

  if (phone && typeof phone === 'string') {
    const { data: org } = await supabase
      .from('organizations')
      .select('name')
      .eq('id', context.organization_id)
      .single()

    const orgName = org?.name || 'our practice'
    const displayDate = new Date(scheduledAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    const displayTime = formatTimeDisplay(time)

    sendSMS(phone, `✅ Confirmed! Your consultation at ${orgName} is booked for ${displayDate} at ${displayTime}. We look forward to seeing you!`)
      .catch(() => { /* Non-critical */ })
  }

  const displayDate = new Date(scheduledAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  return {
    success: true,
    data: {
      appointment_id: appointment!.id,
      scheduled_at: scheduledAt,
      duration: settings.slot_duration_minutes,
      location: settings.location,
    },
    message: `Appointment successfully booked for ${displayDate} at ${formatTimeDisplay(time)}. Duration: ${settings.slot_duration_minutes} minutes.${settings.location ? ` Location: ${settings.location}.` : ''} A confirmation message has been sent to the patient.`,
  }
}

async function executeCheckFinancingStatus(
  supabase: SupabaseClient,
  leadId: string
): Promise<ToolResult> {
  const { data: applications } = await supabase
    .from('financing_applications')
    .select('id, status, lender_name, approved_amount, monthly_payment, interest_rate, term_months')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(5)

  if (!applications || applications.length === 0) {
    return {
      success: true,
      data: { has_applications: false },
      message: 'No financing applications on file. You can offer to send the patient a financing application link.',
    }
  }

  const approved = applications.filter(a => a.status === 'approved')
  const pending = applications.filter(a => a.status === 'pending')

  let message = ''
  if (approved.length > 0) {
    const best = approved.sort((a, b) => (b.approved_amount || 0) - (a.approved_amount || 0))[0]
    message = `Patient has ${approved.length} approved financing option(s). Best offer: $${best.approved_amount?.toLocaleString()} from ${best.lender_name} at ${best.monthly_payment ? `$${best.monthly_payment}/mo` : 'TBD monthly payment'}.`
  } else if (pending.length > 0) {
    message = `Patient has ${pending.length} pending application(s). Waiting for lender decisions.`
  } else {
    message = `Patient has ${applications.length} application(s) but none are approved. Consider reapplying or offering alternative financing.`
  }

  return {
    success: true,
    data: {
      has_applications: true,
      approved_count: approved.length,
      pending_count: pending.length,
      best_offer: approved[0] || null,
    },
    message,
  }
}

async function executeSendFinancingLink(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
  },
  treatmentValue?: number
): Promise<ToolResult> {
  const phone = context.lead.phone_formatted
    ? (decryptField(context.lead.phone_formatted as string) || context.lead.phone_formatted)
    : null

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.example.com'
  const financingUrl = `${appUrl}/financing/${context.lead_id}`

  if (phone && typeof phone === 'string') {
    const valueText = treatmentValue ? ` for your $${treatmentValue.toLocaleString()} treatment plan` : ''
    await sendSMS(
      phone,
      `Here's your personalized financing link${valueText}. See your payment options and apply in 2 minutes (soft credit check only): ${financingUrl}`
    )

    // Log activity
    await supabase.from('lead_activities').insert({
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      activity_type: 'financing_link_sent',
      title: 'AI sent financing application link via SMS',
      metadata: { treatment_value: treatmentValue, source: 'ai_agent' },
    })

    return {
      success: true,
      data: { financing_url: financingUrl },
      message: 'Financing application link has been sent to the patient via SMS. The application uses a soft credit check that won\'t affect their score.',
    }
  }

  return {
    success: false,
    data: {},
    message: 'Could not send financing link — no phone number on file. Share the financing information verbally in the conversation.',
  }
}
