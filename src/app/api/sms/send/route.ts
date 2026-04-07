import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendSMS } from '@/lib/messaging/twilio'
import { z } from 'zod'

const sendSMSSchema = z.object({
  lead_id: z.string().uuid(),
  message: z.string().min(1).max(1600),
  ai_generated: z.boolean().optional().default(false),
})

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const body = await request.json()
  const parsed = sendSMSSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  // Get user profile
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id, full_name')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get lead
  const { data: lead } = await supabase
    .from('leads')
    .select('id, phone_formatted, phone, first_name, last_name, organization_id')
    .eq('id', parsed.data.lead_id)
    .single()

  if (!lead || !lead.phone_formatted) {
    return NextResponse.json({ error: 'Lead not found or has no phone number' }, { status: 404 })
  }

  // Find or create conversation
  let conversation
  const { data: existingConvo } = await supabase
    .from('conversations')
    .select('id')
    .eq('lead_id', lead.id)
    .eq('channel', 'sms')
    .eq('status', 'active')
    .limit(1)
    .single()

  if (existingConvo) {
    conversation = existingConvo
  } else {
    const { data: newConvo } = await supabase
      .from('conversations')
      .insert({
        organization_id: profile.organization_id,
        lead_id: lead.id,
        channel: 'sms',
        status: 'active',
        ai_enabled: true,
        ai_mode: 'assist',
      })
      .select('id')
      .single()
    conversation = newConvo
  }

  if (!conversation) {
    return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 })
  }

  try {
    // Send via Twilio
    const result = await sendSMS(lead.phone_formatted, parsed.data.message)

    // Store message
    const { data: message } = await supabase
      .from('messages')
      .insert({
        organization_id: profile.organization_id,
        conversation_id: conversation.id,
        lead_id: lead.id,
        direction: 'outbound',
        channel: 'sms',
        body: parsed.data.message,
        sender_type: parsed.data.ai_generated ? 'ai' : 'user',
        sender_id: profile.id,
        sender_name: profile.full_name,
        status: 'sent',
        external_id: result.sid,
        ai_generated: parsed.data.ai_generated,
      })
      .select()
      .single()

    // Log activity
    await supabase.from('lead_activities').insert({
      organization_id: profile.organization_id,
      lead_id: lead.id,
      user_id: profile.id,
      activity_type: 'sms_sent',
      title: 'SMS sent',
      description: parsed.data.message.substring(0, 200),
    })

    return NextResponse.json({ message, twilio_sid: result.sid })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to send SMS'
    return NextResponse.json({ error: errorMsg }, { status: 500 })
  }
}
