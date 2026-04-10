import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { generateLeadEngagement } from '@/lib/ai/scoring'
import { sendSMS, validateTwilioWebhook } from '@/lib/messaging/twilio'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { detectPromptInjection, wrapUserContent } from '@/lib/ai/prompt-guard'
import { logHIPAAEvent } from '@/lib/ai/hipaa'
import { searchHash } from '@/lib/encryption'

// POST /api/webhooks/twilio - Incoming SMS from Twilio
export async function POST(request: NextRequest) {
  // Rate limit
  const rlError = applyRateLimit(request, RATE_LIMITS.webhook)
  if (rlError) return rlError

  // Twilio sends form-encoded data — read raw body first for signature validation
  const rawBody = await request.text()
  const params = Object.fromEntries(new URLSearchParams(rawBody))

  // Validate Twilio signature — MANDATORY
  const twilioSignature = request.headers.get('x-twilio-signature')
  if (!twilioSignature) {
    return new NextResponse('Missing Twilio signature', { status: 401 })
  }

  // Build the full URL Twilio used to sign the request
  const url = request.url
  if (!validateTwilioWebhook(twilioSignature, url, params)) {
    return new NextResponse('Invalid Twilio signature', { status: 401 })
  }

  const from = params.From
  const to = params.To
  const body = params.Body
  const messageSid = params.MessageSid

  if (!from || !body) {
    return new NextResponse('Missing required fields', { status: 400 })
  }

  const supabase = createServiceClient()

  // Find lead by phone hash (encrypted lookup) or plaintext fallback
  const phoneHashValue = searchHash(from)
  let lead: any = null
  if (phoneHashValue) {
    const { data } = await supabase
      .from('leads')
      .select('*, organization_id')
      .eq('phone_hash', phoneHashValue)
      .limit(1)
      .single()
    lead = data
  }
  // Fallback for pre-encryption leads (plaintext phone)
  if (!lead) {
    const { data } = await supabase
      .from('leads')
      .select('*, organization_id')
      .or(`phone_formatted.eq.${from},phone.eq.${from}`)
      .limit(1)
      .single()
    lead = data
  }

  if (!lead) {
    // Unknown sender — return empty TwiML
    return new NextResponse(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      { headers: { 'Content-Type': 'text/xml' } }
    )
  }

  // TCPA: Handle opt-out keywords (STOP, UNSUBSCRIBE, CANCEL, END, QUIT)
  const optOutKeywords = /^\s*(stop|unsubscribe|cancel|end|quit)\s*$/i
  if (optOutKeywords.test(body)) {
    await supabase
      .from('leads')
      .update({
        sms_opt_out: true,
        sms_opt_out_at: new Date().toISOString(),
      })
      .eq('id', lead.id)

    // Also exit any active campaign enrollments
    await supabase
      .from('campaign_enrollments')
      .update({ status: 'exited', completed_at: new Date().toISOString() })
      .eq('lead_id', lead.id)
      .eq('status', 'active')

    // Return confirmation TwiML
    return new NextResponse(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Message>You have been unsubscribed and will no longer receive automated messages from us. Reply START to re-subscribe.</Message></Response>',
      { headers: { 'Content-Type': 'text/xml' } }
    )
  }

  // TCPA: Handle re-subscribe (START)
  const optInKeywords = /^\s*(start|subscribe|yes)\s*$/i
  if (optInKeywords.test(body)) {
    await supabase
      .from('leads')
      .update({
        sms_opt_out: false,
        sms_consent: true,
        sms_consent_at: new Date().toISOString(),
        sms_consent_source: 'sms_keyword',
      })
      .eq('id', lead.id)

    return new NextResponse(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Message>You have been re-subscribed to our messages. Reply STOP at any time to unsubscribe.</Message></Response>',
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

    // Detect prompt injection in the incoming SMS before sending to AI
    const injectionCheck = detectPromptInjection(body)
    if (!injectionCheck.isClean) {
      // Log the attempt
      await logHIPAAEvent(supabase, {
        organization_id: lead.organization_id,
        event_type: 'prompt_injection_detected',
        severity: injectionCheck.detections.some(d => d.severity === 'high') ? 'warning' : 'info',
        actor_type: 'webhook',
        resource_type: 'lead',
        resource_id: lead.id,
        description: `Prompt injection attempt detected in SMS: ${injectionCheck.detections.map(d => d.pattern).join(', ')}`,
        metadata: { detections: injectionCheck.detections },
      })
    }

    // Add the new message with sanitized content wrapped in user content tags
    const safeContent = injectionCheck.isClean ? body : injectionCheck.sanitizedText
    history.push({ role: 'user', content: wrapUserContent(safeContent) })

    try {
      const aiResponse = await generateLeadEngagement(lead, history, {
        mode: 'education',
        channel: 'sms',
      }, supabase)

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
