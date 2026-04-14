/**
 * Agent Tools — Function Calling for AI Agents
 *
 * Defines tools that Claude can call during conversations to take
 * real actions: check appointment availability, create bookings,
 * send financing links, and cross-channel content delivery.
 *
 * Cross-channel tools enable the AI to send SMS/email from any channel:
 * - send_sms_to_lead: Send a custom SMS message
 * - send_email_to_lead: Send a custom email
 * - send_practice_info: Send practice address/hours/directions
 * - send_testimonial: Send a patient testimonial video/story
 * - send_before_after: Send before/after transformation photos
 *
 * These tools are injected into the Anthropic API call as tool definitions.
 * When Claude returns a tool_use block, we execute the tool and continue.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { generateAvailableSlots, formatTimeDisplay, type BookingConfig, type ExistingAppointment } from '@/lib/booking/availability'
import { encryptLeadPII } from '@/lib/encryption'
import { sendSMS } from '@/lib/messaging/twilio'
import { sendEmail } from '@/lib/messaging/resend'
import { decryptField } from '@/lib/encryption'
import { auditPHIWrite, auditPHITransmission } from '@/lib/hipaa-audit'
import { getAssetsByType, getRandomAssets, getPracticeInfo, incrementUsage, recordDelivery } from '@/lib/content/practice-assets'
import { formatAssetForSMS, formatAssetForEmail, formatCustomSMS, formatCustomEmail } from '@/lib/content/delivery-templates'
import { getTreatmentClosing, getClosingProgress, advanceStep } from '@/lib/treatment/treatment-closing'
import type Anthropic from '@anthropic-ai/sdk'

// ═══════════════════════════════════════════════════════════
// TOOL DEFINITIONS (sent to Claude)
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// CROSS-CHANNEL TOOL DEFINITIONS (shared by Setter & Closer)
// ═══════════════════════════════════════════════════════════

const CROSS_CHANNEL_TOOLS: Anthropic.Tool[] = [
  {
    name: 'send_sms_to_lead',
    description: 'Send a custom SMS text message to the patient. Use this when the patient asks you to text them information, or when you need to send something that\'s better in written form (e.g., a link, address, confirmation). Works from any channel — you can send a text while on a phone call.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: {
          type: 'string',
          description: 'The SMS message to send. Keep it under 300 characters. Be concise and include any relevant links or details.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'send_email_to_lead',
    description: 'Send a custom email to the patient. Use this when the patient asks for detailed information via email, or when you need to send something that benefits from rich formatting (images, detailed text). Works from any channel.',
    input_schema: {
      type: 'object' as const,
      properties: {
        subject: {
          type: 'string',
          description: 'The email subject line.',
        },
        message: {
          type: 'string',
          description: 'The email body content. Can be longer and more detailed than SMS.',
        },
      },
      required: ['subject', 'message'],
    },
  },
  {
    name: 'send_practice_info',
    description: 'Send the practice\'s address, phone number, hours, and directions to the patient. Use when they ask "where are you located?", "what\'s the address?", "how do I get there?", or any location-related question. Sends via SMS by default, or email if specified.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: {
          type: 'string',
          enum: ['sms', 'email'],
          description: 'Which channel to send via. Default is SMS.',
        },
      },
      required: [],
    },
  },
  {
    name: 'send_testimonial',
    description: 'Send a patient testimonial video or story to the patient. Use when they ask about reviews, patient experiences, success stories, or want social proof. Sends via SMS (with video link) or email (with embedded thumbnail).',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: {
          type: 'string',
          enum: ['sms', 'email'],
          description: 'Which channel to send via. Default is SMS for quick video link, email for richer presentation.',
        },
      },
      required: [],
    },
  },
  {
    name: 'send_before_after',
    description: 'Send before-and-after transformation photos to the patient. Use when they ask to see results, transformations, or examples of work. Email is preferred (can embed images), SMS sends a link to the photo gallery.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: {
          type: 'string',
          enum: ['sms', 'email'],
          description: 'Which channel to send via. Default is email for image embeds.',
        },
      },
      required: [],
    },
  },
]

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
  ...CROSS_CHANNEL_TOOLS,
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
  {
    name: 'check_closing_progress',
    description: 'Check where the patient is in the treatment closing workflow (contract → financing → consent → pre-op → surgery → records). Use this to know what step comes next.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'send_preop_instructions',
    description: 'Send pre-operative and post-operative care instructions to the patient via SMS, email, or both. Use this after consent forms are signed and before surgery.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: {
          type: 'string',
          enum: ['sms', 'email', 'both'],
          description: 'Channel to deliver pre-op instructions. Default: both.',
        },
      },
      required: [],
    },
  },
  {
    name: 'schedule_follow_up_consultation',
    description: 'Schedule a follow-up consultation for a patient who hasn\'t committed after their initial consultation. This is a re-close opportunity — a second visit to address remaining concerns.',
    input_schema: {
      type: 'object' as const,
      properties: {
        preferred_day: {
          type: 'string',
          description: 'Preferred day of the week (e.g., "monday", "friday").',
        },
        consultation_type: {
          type: 'string',
          enum: ['in_person', 'virtual', 'phone'],
          description: 'Type of follow-up consultation.',
        },
      },
      required: [],
    },
  },
  ...CROSS_CHANNEL_TOOLS,
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
    channel?: string // The current channel the agent is on
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

    // Cross-channel tools
    case 'send_sms_to_lead':
      return executeSendSMSToLead(supabase, context, toolInput.message as string)

    case 'send_email_to_lead':
      return executeSendEmailToLead(supabase, context, toolInput.subject as string, toolInput.message as string)

    case 'send_practice_info':
      return executeSendPracticeInfo(supabase, context, (toolInput.channel as string) || 'sms')

    case 'send_testimonial':
      return executeSendTestimonial(supabase, context, (toolInput.channel as string) || 'sms')

    case 'send_before_after':
      return executeSendBeforeAfter(supabase, context, (toolInput.channel as string) || 'email')

    // Treatment closing tools
    case 'check_closing_progress':
      return executeCheckClosingProgress(supabase, context.lead_id)

    case 'send_preop_instructions':
      return executeSendPreopInstructions(supabase, context, (toolInput.channel as string) || 'both')

    case 'schedule_follow_up_consultation':
      return executeScheduleFollowUp(supabase, context, toolInput.preferred_day as string | undefined, (toolInput.consultation_type as string) || 'in_person')

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

  // HIPAA audit for PHI-touching booking action
  auditPHIWrite(
    { supabase, organizationId: context.organization_id, actorType: 'ai_agent' },
    'appointment',
    appointment!.id,
    'AI agent created appointment booking during conversation',
  )

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

    // HIPAA audit for PHI-touching financing action
    auditPHIWrite(
      { supabase, organizationId: context.organization_id, actorType: 'ai_agent' },
      'financing',
      context.lead_id,
      'AI agent sent financing application link via SMS',
    )

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

// ═══════════════════════════════════════════════════════════
// CROSS-CHANNEL TOOL IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════

/**
 * Helper: Get lead contact info and org name for cross-channel delivery.
 */
async function getCrossChannelContext(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
  }
): Promise<{ phone: string | null; email: string | null; leadName: string; orgName: string }> {
  const phone = context.lead.phone_formatted
    ? (decryptField(context.lead.phone_formatted as string) || context.lead.phone_formatted as string)
    : null

  const email = context.lead.email
    ? (decryptField(context.lead.email as string) || context.lead.email as string)
    : null

  const leadName = (context.lead.first_name as string) || ''

  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', context.organization_id)
    .single()

  return { phone, email, leadName, orgName: org?.name || 'our practice' }
}

/**
 * Helper: Store an outbound message record from a cross-channel delivery.
 */
async function storeOutboundMessage(
  supabase: SupabaseClient,
  params: {
    organization_id: string
    conversation_id: string
    lead_id: string
    channel: 'sms' | 'email'
    body: string
    external_id?: string
    metadata?: Record<string, unknown>
  }
): Promise<string | null> {
  const { data } = await supabase
    .from('messages')
    .insert({
      organization_id: params.organization_id,
      conversation_id: params.conversation_id,
      lead_id: params.lead_id,
      direction: 'outbound',
      channel: params.channel,
      body: params.body,
      sender_type: 'ai',
      status: 'sent',
      external_id: params.external_id || null,
      ai_generated: true,
      metadata: {
        cross_channel: true,
        ...params.metadata,
      },
    })
    .select('id')
    .single()

  return data?.id || null
}

/**
 * send_sms_to_lead — Send a custom SMS to the lead.
 */
async function executeSendSMSToLead(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
    channel?: string
  },
  message: string
): Promise<ToolResult> {
  // Consent check
  if (!context.lead.sms_consent || context.lead.sms_opt_out) {
    return { success: false, data: {}, message: 'Cannot send SMS — patient has not given SMS consent or has opted out. Provide the information verbally instead.' }
  }

  const { phone, leadName, orgName } = await getCrossChannelContext(supabase, context)
  if (!phone) {
    return { success: false, data: {}, message: 'Cannot send SMS — no phone number on file. Ask the patient for their phone number.' }
  }

  const formattedMessage = formatCustomSMS(message, leadName)

  try {
    const result = await sendSMS(phone, formattedMessage)

    // Store message record
    const messageId = await storeOutboundMessage(supabase, {
      organization_id: context.organization_id,
      conversation_id: context.conversation_id,
      lead_id: context.lead_id,
      channel: 'sms',
      body: formattedMessage,
      external_id: result.sid,
      metadata: { tool: 'send_sms_to_lead', source_channel: context.channel },
    })

    // Track cross-channel delivery
    await recordDelivery(supabase, {
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      conversation_id: context.conversation_id,
      triggered_by_channel: context.channel || 'voice',
      delivered_via_channel: 'sms',
      content_type: 'custom_message',
      message_id: messageId || undefined,
      status: 'sent',
      tool_name: 'send_sms_to_lead',
    })

    // Log activity
    await supabase.from('lead_activities').insert({
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      activity_type: 'cross_channel_sms_sent',
      title: `AI sent SMS during ${context.channel || 'conversation'}`,
      description: formattedMessage.substring(0, 200),
      metadata: { tool: 'send_sms_to_lead', source_channel: context.channel },
    })

    // HIPAA audit
    auditPHITransmission(
      { supabase, organizationId: context.organization_id, actorType: 'ai_agent' },
      'cross_channel_sms',
      context.lead_id,
      'Twilio (SMS)',
      ['phone']
    )

    return {
      success: true,
      data: { message_id: messageId },
      message: `SMS sent successfully to the patient. Message: "${formattedMessage.substring(0, 100)}..."`,
    }
  } catch (error) {
    return {
      success: false,
      data: {},
      message: `Failed to send SMS: ${error instanceof Error ? error.message : 'Unknown error'}. Share the information verbally instead.`,
    }
  }
}

/**
 * send_email_to_lead — Send a custom email to the lead.
 */
async function executeSendEmailToLead(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
    channel?: string
  },
  subject: string,
  message: string
): Promise<ToolResult> {
  // Consent check
  if (!context.lead.email_consent || context.lead.email_opt_out) {
    return { success: false, data: {}, message: 'Cannot send email — patient has not given email consent or has opted out. Provide the information verbally or via SMS instead.' }
  }

  const { email, leadName, orgName } = await getCrossChannelContext(supabase, context)
  if (!email) {
    return { success: false, data: {}, message: 'Cannot send email — no email address on file. Ask the patient for their email address.' }
  }

  const formatted = formatCustomEmail(message, leadName, orgName, {
    subject,
    leadId: context.lead_id,
    orgId: context.organization_id,
  })

  try {
    const result = await sendEmail({
      to: email,
      subject: formatted.subject,
      html: formatted.html,
      text: formatted.text,
    })

    // Store message record
    const messageId = await storeOutboundMessage(supabase, {
      organization_id: context.organization_id,
      conversation_id: context.conversation_id,
      lead_id: context.lead_id,
      channel: 'email',
      body: message,
      external_id: result.id,
      metadata: { tool: 'send_email_to_lead', subject, source_channel: context.channel },
    })

    // Track cross-channel delivery
    await recordDelivery(supabase, {
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      conversation_id: context.conversation_id,
      triggered_by_channel: context.channel || 'voice',
      delivered_via_channel: 'email',
      content_type: 'custom_message',
      message_id: messageId || undefined,
      status: 'sent',
      tool_name: 'send_email_to_lead',
    })

    // Log activity
    await supabase.from('lead_activities').insert({
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      activity_type: 'cross_channel_email_sent',
      title: `AI sent email during ${context.channel || 'conversation'}: ${subject}`,
      metadata: { tool: 'send_email_to_lead', subject, source_channel: context.channel },
    })

    return {
      success: true,
      data: { message_id: messageId },
      message: `Email sent successfully to the patient with subject "${subject}".`,
    }
  } catch (error) {
    return {
      success: false,
      data: {},
      message: `Failed to send email: ${error instanceof Error ? error.message : 'Unknown error'}. Share the information verbally or via SMS instead.`,
    }
  }
}

/**
 * send_practice_info — Send practice address, hours, and directions.
 */
async function executeSendPracticeInfo(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
    channel?: string
  },
  deliveryChannel: string
): Promise<ToolResult> {
  const { phone, email, leadName, orgName } = await getCrossChannelContext(supabase, context)

  // Get practice info asset
  const practiceInfo = await getPracticeInfo(supabase, context.organization_id)
  if (!practiceInfo) {
    // Fallback: try to get from org settings
    const { data: org } = await supabase
      .from('organizations')
      .select('address, phone, website')
      .eq('id', context.organization_id)
      .single()

    if (org?.address) {
      const addr = org.address as Record<string, string>
      const addressText = [addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(', ')
      return {
        success: true,
        data: { address: addressText },
        message: `Practice address: ${addressText}${org.phone ? `. Phone: ${org.phone}` : ''}. Note: No detailed practice info asset configured. The address has been shared verbally.`,
      }
    }
    return { success: false, data: {}, message: 'No practice info configured. Share the address verbally.' }
  }

  // Track usage
  await incrementUsage(supabase, practiceInfo.id)

  if (deliveryChannel === 'sms') {
    if (!context.lead.sms_consent || context.lead.sms_opt_out || !phone) {
      return { success: false, data: {}, message: 'Cannot send SMS — no consent or no phone. Share practice info verbally.' }
    }

    const smsContent = formatAssetForSMS(practiceInfo, leadName, orgName)
    const result = await sendSMS(phone, smsContent)

    const messageId = await storeOutboundMessage(supabase, {
      organization_id: context.organization_id,
      conversation_id: context.conversation_id,
      lead_id: context.lead_id,
      channel: 'sms',
      body: smsContent,
      external_id: result.sid,
      metadata: { tool: 'send_practice_info', content_asset_id: practiceInfo.id },
    })

    await recordDelivery(supabase, {
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      conversation_id: context.conversation_id,
      triggered_by_channel: context.channel || 'voice',
      delivered_via_channel: 'sms',
      content_type: 'practice_info',
      content_asset_id: practiceInfo.id,
      message_id: messageId || undefined,
      status: 'sent',
      tool_name: 'send_practice_info',
    })

    await supabase.from('lead_activities').insert({
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      activity_type: 'cross_channel_practice_info_sent',
      title: `AI sent practice info via SMS during ${context.channel || 'conversation'}`,
      metadata: { tool: 'send_practice_info', delivery_channel: 'sms' },
    })

    return { success: true, data: { content_asset_id: practiceInfo.id }, message: 'Practice address and directions have been texted to the patient.' }
  } else {
    // Email delivery
    if (!context.lead.email_consent || context.lead.email_opt_out || !email) {
      return { success: false, data: {}, message: 'Cannot send email — no consent or no email address. Try SMS or share verbally.' }
    }

    const emailContent = formatAssetForEmail(practiceInfo, leadName, orgName, {
      leadId: context.lead_id,
      orgId: context.organization_id,
    })

    const result = await sendEmail({ to: email, ...emailContent })

    const messageId = await storeOutboundMessage(supabase, {
      organization_id: context.organization_id,
      conversation_id: context.conversation_id,
      lead_id: context.lead_id,
      channel: 'email',
      body: emailContent.text,
      external_id: result.id,
      metadata: { tool: 'send_practice_info', content_asset_id: practiceInfo.id, subject: emailContent.subject },
    })

    await recordDelivery(supabase, {
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      conversation_id: context.conversation_id,
      triggered_by_channel: context.channel || 'voice',
      delivered_via_channel: 'email',
      content_type: 'practice_info',
      content_asset_id: practiceInfo.id,
      message_id: messageId || undefined,
      status: 'sent',
      tool_name: 'send_practice_info',
    })

    return { success: true, data: { content_asset_id: practiceInfo.id }, message: 'Practice address and directions have been emailed to the patient.' }
  }
}

/**
 * send_testimonial — Send a patient testimonial video/story.
 */
async function executeSendTestimonial(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
    channel?: string
  },
  deliveryChannel: string
): Promise<ToolResult> {
  const { phone, email, leadName, orgName } = await getCrossChannelContext(supabase, context)

  // Get a random testimonial (for variety)
  const testimonials = await getRandomAssets(supabase, context.organization_id, 'testimonial_video', 1)
  if (testimonials.length === 0) {
    return { success: false, data: {}, message: 'No testimonial videos configured. Mention verbally that you have many happy patients and offer to share more during the consultation.' }
  }

  const testimonial = testimonials[0]
  await incrementUsage(supabase, testimonial.id)

  if (deliveryChannel === 'sms') {
    if (!context.lead.sms_consent || context.lead.sms_opt_out || !phone) {
      return { success: false, data: {}, message: 'Cannot send SMS — no consent or no phone. Mention the testimonials verbally.' }
    }

    const smsContent = formatAssetForSMS(testimonial, leadName, orgName)
    const result = await sendSMS(phone, smsContent)

    const messageId = await storeOutboundMessage(supabase, {
      organization_id: context.organization_id,
      conversation_id: context.conversation_id,
      lead_id: context.lead_id,
      channel: 'sms',
      body: smsContent,
      external_id: result.sid,
      metadata: { tool: 'send_testimonial', content_asset_id: testimonial.id },
    })

    await recordDelivery(supabase, {
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      conversation_id: context.conversation_id,
      triggered_by_channel: context.channel || 'voice',
      delivered_via_channel: 'sms',
      content_type: 'testimonial_video',
      content_asset_id: testimonial.id,
      message_id: messageId || undefined,
      status: 'sent',
      tool_name: 'send_testimonial',
    })

    await supabase.from('lead_activities').insert({
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      activity_type: 'cross_channel_testimonial_sent',
      title: `AI sent testimonial video via SMS: ${testimonial.title}`,
      metadata: { tool: 'send_testimonial', asset_title: testimonial.title, delivery_channel: 'sms' },
    })

    return { success: true, data: { content_asset_id: testimonial.id, title: testimonial.title }, message: `Patient testimonial "${testimonial.title}" has been texted to the patient with a link to the video.` }
  } else {
    if (!context.lead.email_consent || context.lead.email_opt_out || !email) {
      return { success: false, data: {}, message: 'Cannot send email — no consent or no email. Try SMS or mention verbally.' }
    }

    const emailContent = formatAssetForEmail(testimonial, leadName, orgName, {
      leadId: context.lead_id,
      orgId: context.organization_id,
    })

    const result = await sendEmail({ to: email, ...emailContent })

    const messageId = await storeOutboundMessage(supabase, {
      organization_id: context.organization_id,
      conversation_id: context.conversation_id,
      lead_id: context.lead_id,
      channel: 'email',
      body: emailContent.text,
      external_id: result.id,
      metadata: { tool: 'send_testimonial', content_asset_id: testimonial.id, subject: emailContent.subject },
    })

    await recordDelivery(supabase, {
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      conversation_id: context.conversation_id,
      triggered_by_channel: context.channel || 'voice',
      delivered_via_channel: 'email',
      content_type: 'testimonial_video',
      content_asset_id: testimonial.id,
      message_id: messageId || undefined,
      status: 'sent',
      tool_name: 'send_testimonial',
    })

    return { success: true, data: { content_asset_id: testimonial.id, title: testimonial.title }, message: `Patient testimonial "${testimonial.title}" has been emailed to the patient with an embedded video link.` }
  }
}

/**
 * send_before_after — Send before/after transformation photos.
 */
async function executeSendBeforeAfter(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
    channel?: string
  },
  deliveryChannel: string
): Promise<ToolResult> {
  const { phone, email, leadName, orgName } = await getCrossChannelContext(supabase, context)

  // Get random before/after photos (send up to 2 for variety)
  const photos = await getRandomAssets(supabase, context.organization_id, 'before_after_photo', 2)
  if (photos.length === 0) {
    return { success: false, data: {}, message: 'No before/after photos configured. Mention verbally that you can show them transformations during the consultation.' }
  }

  const photo = photos[0]
  await incrementUsage(supabase, photo.id)

  if (deliveryChannel === 'sms') {
    if (!context.lead.sms_consent || context.lead.sms_opt_out || !phone) {
      return { success: false, data: {}, message: 'Cannot send SMS — no consent or no phone. Try email or mention verbally.' }
    }

    const smsContent = formatAssetForSMS(photo, leadName, orgName)
    const result = await sendSMS(phone, smsContent)

    const messageId = await storeOutboundMessage(supabase, {
      organization_id: context.organization_id,
      conversation_id: context.conversation_id,
      lead_id: context.lead_id,
      channel: 'sms',
      body: smsContent,
      external_id: result.sid,
      metadata: { tool: 'send_before_after', content_asset_id: photo.id },
    })

    await recordDelivery(supabase, {
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      conversation_id: context.conversation_id,
      triggered_by_channel: context.channel || 'voice',
      delivered_via_channel: 'sms',
      content_type: 'before_after_photo',
      content_asset_id: photo.id,
      message_id: messageId || undefined,
      status: 'sent',
      tool_name: 'send_before_after',
    })

    await supabase.from('lead_activities').insert({
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      activity_type: 'cross_channel_before_after_sent',
      title: `AI sent before/after photos via SMS: ${photo.title}`,
      metadata: { tool: 'send_before_after', asset_title: photo.title, delivery_channel: 'sms' },
    })

    return { success: true, data: { content_asset_id: photo.id }, message: `Before/after transformation "${photo.title}" has been texted to the patient with a link to view the photos.` }
  } else {
    if (!context.lead.email_consent || context.lead.email_opt_out || !email) {
      return { success: false, data: {}, message: 'Cannot send email — no consent or no email. Try SMS instead.' }
    }

    const emailContent = formatAssetForEmail(photo, leadName, orgName, {
      leadId: context.lead_id,
      orgId: context.organization_id,
    })

    const result = await sendEmail({ to: email, ...emailContent })

    const messageId = await storeOutboundMessage(supabase, {
      organization_id: context.organization_id,
      conversation_id: context.conversation_id,
      lead_id: context.lead_id,
      channel: 'email',
      body: emailContent.text,
      external_id: result.id,
      metadata: { tool: 'send_before_after', content_asset_id: photo.id, subject: emailContent.subject },
    })

    await recordDelivery(supabase, {
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      conversation_id: context.conversation_id,
      triggered_by_channel: context.channel || 'voice',
      delivered_via_channel: 'email',
      content_type: 'before_after_photo',
      content_asset_id: photo.id,
      message_id: messageId || undefined,
      status: 'sent',
      tool_name: 'send_before_after',
    })

    return { success: true, data: { content_asset_id: photo.id }, message: `Before/after transformation "${photo.title}" has been emailed to the patient with embedded comparison photos.` }
  }
}

// ═══════════════════════════════════════════════════════════
// TREATMENT CLOSING TOOLS
// ═══════════════════════════════════════════════════════════

async function executeCheckClosingProgress(
  supabase: SupabaseClient,
  leadId: string
): Promise<ToolResult> {
  const closing = await getTreatmentClosing(supabase, leadId)

  if (!closing) {
    return {
      success: true,
      data: { has_closing: false },
      message: 'No treatment closing workflow has been started for this patient yet. The workflow begins when the treatment plan is presented and the patient starts the commitment process.',
    }
  }

  const progress = getClosingProgress(closing)

  return {
    success: true,
    data: {
      has_closing: true,
      current_step: progress.current_step,
      percent_complete: progress.percent_complete,
      steps_completed: progress.steps_completed,
      steps_remaining: progress.steps_remaining,
      next_action: progress.next_action,
      surgery_date: closing.surgery_date,
      surgery_in_days: progress.surgery_in_days,
      blockers: progress.blockers,
    },
    message: `Treatment Closing Progress: ${progress.percent_complete}% complete.\nCurrent step: ${progress.current_step_label}\nNext action: ${progress.next_action}\n${progress.next_action_detail}\n${progress.blockers.length > 0 ? `⚠️ Blockers: ${progress.blockers.join('; ')}` : ''}${closing.surgery_date ? `\nSurgery scheduled: ${closing.surgery_date}` : ''}`,
  }
}

async function executeSendPreopInstructions(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
    channel?: string
  },
  channel: string
): Promise<ToolResult> {
  const phone = context.lead.phone as string | undefined
  const email = context.lead.email as string | undefined
  const firstName = (context.lead.first_name as string) || 'there'
  const decryptedPhone = phone ? decryptField(phone) : null
  const decryptedEmail = email ? decryptField(email) : null

  const preOpSMS = `${firstName}, here are your pre-op instructions for surgery day:\n\n🚫 Nothing to eat or drink 8 hours before\n🚗 Arrange a ride home (no driving after sedation)\n💊 Take prescribed meds as directed\n👕 Wear comfortable, loose clothing\n⏰ Arrive 15 min early\n🪪 Bring ID & insurance card\n🚭 No smoking 48 hours before\n\nPost-op care instructions will follow. Questions? Just text or call us!`

  const preOpEmail = `<h2>Pre-Operative Instructions</h2>
<p>Hi ${firstName},</p>
<p>Your surgery date is approaching — congratulations! Here's everything you need to know to prepare:</p>

<h3>Before Surgery</h3>
<ul>
<li><strong>Fasting:</strong> Nothing to eat or drink 8 hours before your appointment</li>
<li><strong>Transportation:</strong> Arrange a ride home — you cannot drive after IV sedation</li>
<li><strong>Medications:</strong> Take prescribed medications as directed by Dr. Samadian</li>
<li><strong>Clothing:</strong> Wear comfortable, loose-fitting clothing</li>
<li><strong>Arrival:</strong> Please arrive 15 minutes early</li>
<li><strong>Documents:</strong> Bring your photo ID and insurance card</li>
<li><strong>Smoking:</strong> No smoking for 48 hours before surgery</li>
</ul>

<h3>After Surgery (Post-Op Care)</h3>
<ul>
<li><strong>Ice:</strong> Apply ice packs 20 minutes on, 20 minutes off for the first 48 hours</li>
<li><strong>Diet:</strong> Soft foods only for the first 2 weeks (smoothies, soups, mashed potatoes, yogurt)</li>
<li><strong>Medications:</strong> Take ALL prescribed medications as directed — do not skip pain meds</li>
<li><strong>Oral Care:</strong> No spitting, no straws, no smoking for 72 hours</li>
<li><strong>Rinsing:</strong> Gentle warm salt water rinses after 24 hours</li>
<li><strong>Follow-up:</strong> Your follow-up appointment is in 7-10 days</li>
</ul>

<p><strong>Questions?</strong> Call or text us anytime. We're here for you!</p>
<p>— The Team at Dion Health</p>`

  let sentVia: string[] = []

  if ((channel === 'sms' || channel === 'both') && decryptedPhone) {
    try {
      await sendSMS(decryptedPhone, preOpSMS)
      sentVia.push('SMS')

      await storeOutboundMessage(supabase, {
        organization_id: context.organization_id,
        conversation_id: context.conversation_id,
        lead_id: context.lead_id,
        channel: 'sms',
        body: preOpSMS,
        metadata: { tool: 'send_preop_instructions', type: 'preop' },
      })
    } catch (err) {
      console.error('[PreOp SMS] Error:', err)
    }
  }

  if ((channel === 'email' || channel === 'both') && decryptedEmail) {
    try {
      await sendEmail({
        to: decryptedEmail,
        subject: `${firstName}, Your Pre-Op & Post-Op Instructions — Please Read Before Surgery`,
        html: preOpEmail,
        text: preOpSMS,
      })
      sentVia.push('Email')

      await storeOutboundMessage(supabase, {
        organization_id: context.organization_id,
        conversation_id: context.conversation_id,
        lead_id: context.lead_id,
        channel: 'email',
        body: preOpSMS,
        metadata: { tool: 'send_preop_instructions', type: 'preop', subject: 'Pre-Op Instructions' },
      })
    } catch (err) {
      console.error('[PreOp Email] Error:', err)
    }
  }

  if (sentVia.length === 0) {
    return { success: false, data: {}, message: 'Could not send pre-op instructions — no valid phone or email on file.' }
  }

  // Advance treatment closing workflow
  await advanceStep(supabase, context.lead_id, 'preop_instructions_sent', {
    preop_sent_via: sentVia.length === 2 ? 'both' : sentVia[0].toLowerCase() as 'sms' | 'email',
  })

  await supabase.from('lead_activities').insert({
    organization_id: context.organization_id,
    lead_id: context.lead_id,
    activity_type: 'preop_instructions_sent',
    title: `Pre-op & post-op instructions sent via ${sentVia.join(' + ')}`,
    metadata: { tool: 'send_preop_instructions', channels: sentVia },
  })

  auditPHITransmission(
    { supabase, organizationId: context.organization_id, actorType: 'ai_agent' },
    'preop_instructions',
    context.lead_id,
    sentVia.join('+').toLowerCase(),
    ['phone', 'email']
  )

  return {
    success: true,
    data: { channels: sentVia },
    message: `Pre-operative and post-operative care instructions have been sent to the patient via ${sentVia.join(' and ')}. The instructions cover fasting, medication, transportation, and recovery care.`,
  }
}

async function executeScheduleFollowUp(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
  },
  preferredDay?: string,
  consultationType: string = 'in_person'
): Promise<ToolResult> {
  // Get available slots (reuse existing availability logic)
  const { data: settings } = await supabase
    .from('booking_settings')
    .select('*')
    .eq('organization_id', context.organization_id)
    .single()

  if (!settings || !settings.is_enabled) {
    return { success: false, data: {}, message: 'Online booking is not currently available. Please have the patient call to schedule a follow-up consultation.' }
  }

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
      data: { slots: [] },
      message: preferredDay
        ? `No follow-up consultation slots available on ${preferredDay}s. Other available dates: ${slots.slice(0, 3).map(s => s.dayLabel).join(', ')}.`
        : 'No available follow-up consultation slots in the upcoming schedule. Please have the patient call the office directly.',
    }
  }

  const slotSummary = filteredSlots.slice(0, 5).map(day => {
    const times = day.times.slice(0, 4).map(t => formatTimeDisplay(t)).join(', ')
    const more = day.times.length > 4 ? ` (+${day.times.length - 4} more)` : ''
    return `${day.dayLabel}: ${times}${more}`
  }).join('\n')

  const typeLabel = consultationType === 'virtual' ? 'virtual video call' :
    consultationType === 'phone' ? 'phone consultation' : 'in-person follow-up'

  return {
    success: true,
    data: {
      slots: filteredSlots.slice(0, 5).map(d => ({
        date: d.date,
        dayLabel: d.dayLabel,
        times: d.times.slice(0, 6),
      })),
      consultation_type: consultationType,
    },
    message: `Available ${typeLabel} slots:\n${slotSummary}\n\nThis is a follow-up consultation to address any remaining questions. Ask the patient which date and time works best, then use create_booking to confirm.`,
  }
}
