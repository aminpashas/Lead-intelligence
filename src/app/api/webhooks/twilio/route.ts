import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { generateLeadEngagement } from '@/lib/ai/scoring'
import { sendSMS } from '@/lib/messaging/twilio'

// POST /api/webhooks/twilio - Incoming SMS from Twilio
export async function POST(request: NextRequest) {
  const formData = await request.formData()
  const from = formData.get('From') as string
  const to = formData.get('To') as string
  const body = formData.get('Body') as string
  const messageSid = formData.get('MessageSid') as string

  if (!from || !body) {
    return new NextResponse('Missing required fields', { status: 400 })
  }

  const supabase = createServiceClient()

  // Find lead by phone number
  const { data: lead } = await supabase
    .from('leads')
    .select('*, organization_id')
    .or(`phone_formatted.eq.${from},phone.eq.${from}`)
    .limit(1)
    .single()

  if (!lead) {
    // Unknown sender — return empty TwiML
    return new NextResponse(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      { headers: { 'Content-Type': 'text/xml' } }
    )
  }

  // Find or create conversation
  let conversation
  const { data: existingConvo } = await supabase
    .from('conversations')
    .select('*')
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
        organization_id: lead.organization_id,
        lead_id: lead.id,
        channel: 'sms',
        status: 'active',
        ai_enabled: true,
        ai_mode: 'auto',
      })
      .select()
      .single()
    conversation = newConvo
  }

  if (!conversation) {
    return new NextResponse('Server error', { status: 500 })
  }

  // Store inbound message
  await supabase.from('messages').insert({
    organization_id: lead.organization_id,
    conversation_id: conversation.id,
    lead_id: lead.id,
    direction: 'inbound',
    channel: 'sms',
    body,
    sender_type: 'lead',
    sender_name: `${lead.first_name} ${lead.last_name || ''}`.trim(),
    status: 'delivered',
    external_id: messageSid,
  })

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: lead.organization_id,
    lead_id: lead.id,
    activity_type: 'sms_received',
    title: 'SMS received',
    description: body.substring(0, 200),
  })

  // Auto-respond with AI if enabled
  if (conversation.ai_enabled && conversation.ai_mode === 'auto') {
    // Get conversation history
    const { data: messages } = await supabase
      .from('messages')
      .select('direction, body, sender_type')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: true })
      .limit(20)

    const history = (messages || []).map((m: { direction: string; body: string; sender_type: string }) => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.body,
    }))

    // Add the new message
    history.push({ role: 'user', content: body })

    try {
      const aiResponse = await generateLeadEngagement(lead, history, {
        mode: 'education',
        channel: 'sms',
      })

      // Send AI response via Twilio
      const smsResult = await sendSMS(from, aiResponse.message)

      // Store outbound message
      await supabase.from('messages').insert({
        organization_id: lead.organization_id,
        conversation_id: conversation.id,
        lead_id: lead.id,
        direction: 'outbound',
        channel: 'sms',
        body: aiResponse.message,
        sender_type: 'ai',
        status: 'sent',
        external_id: smsResult.sid,
        ai_generated: true,
        ai_confidence: aiResponse.confidence,
        ai_model: 'claude-sonnet-4-20250514',
      })
    } catch {
      // AI response failure shouldn't cause webhook failure
    }
  }

  // Return empty TwiML (we're handling response via API, not TwiML)
  return new NextResponse(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    { headers: { 'Content-Type': 'text/xml' } }
  )
}
