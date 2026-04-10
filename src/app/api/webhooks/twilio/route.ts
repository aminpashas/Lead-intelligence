import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { generateLeadEngagement } from '@/lib/ai/scoring'
import { sendSMS, validateTwilioWebhook } from '@/lib/messaging/twilio'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { detectPromptInjection, wrapUserContent } from '@/lib/ai/prompt-guard'
import { logHIPAAEvent } from '@/lib/ai/hipaa'
import { exitCampaignsOnReply } from '@/lib/campaigns/enrollments'
import { searchHash } from '@/lib/encryption'
import { routeToAgent, getHandoffHistory } from '@/lib/ai/agent-handoff'
import { getPatientProfile } from '@/lib/ai/patient-psychology'
import type { AgentContext, ConversationMessage } from '@/lib/ai/agent-types'
import type { PatientProfile, ConversationChannel, LeadStatus } from '@/types/database'

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

  // Update lead engagement stats
  await supabase.from('leads').update({
    last_responded_at: new Date().toISOString(),
    total_sms_received: (lead.total_sms_received || 0) + 1,
  }).eq('id', lead.id)

  // Update conversation stats
  await supabase.from('conversations').update({
    last_message_at: new Date().toISOString(),
    last_message_preview: body.substring(0, 100),
    unread_count: (conversation.unread_count || 0) + 1,
    message_count: (conversation.message_count || 0) + 1,
  }).eq('id', conversation.id)

  // Exit campaigns with if_replied exit condition
  await exitCampaignsOnReply(supabase, lead.id, lead.organization_id)

  // Auto-respond with AI agent system if enabled
  if (conversation.ai_enabled && conversation.ai_mode === 'auto') {
    // Get conversation history
    const { data: messages } = await supabase
      .from('messages')
      .select('direction, body, sender_type')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: true })
      .limit(20)

    const history: ConversationMessage[] = (messages || []).map((m: { direction: string; body: string; sender_type: string }) => ({
      role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.body,
    }))

    // Detect prompt injection in the incoming SMS before sending to AI
    const injectionCheck = detectPromptInjection(body)
    if (!injectionCheck.isClean) {
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
      // Fetch patient profile and handoff history for agent context
      const patientProfileRaw = await getPatientProfile(supabase, lead.id)
      const patientProfile = patientProfileRaw as PatientProfile | null
      const handoffHistory = await getHandoffHistory(supabase, conversation.id)

      // Build agent context
      const agentContext: AgentContext = {
        lead,
        conversation_id: conversation.id,
        organization_id: lead.organization_id,
        channel: (conversation.channel || 'sms') as ConversationChannel,
        lead_status: lead.status as LeadStatus,
        patient_profile: patientProfile,
        conversation_history: history,
        handoff_history: handoffHistory,
        message_count: conversation.message_count || messages?.length || 0,
      }

      // Route to the appropriate agent (Setter or Closer)
      const agentResponse = await routeToAgent(supabase, agentContext)

      // Send AI response via Twilio
      const smsResult = await sendSMS(from, agentResponse.message)

      // Store outbound message with agent metadata
      await supabase.from('messages').insert({
        organization_id: lead.organization_id,
        conversation_id: conversation.id,
        lead_id: lead.id,
        direction: 'outbound',
        channel: 'sms',
        body: agentResponse.message,
        sender_type: 'ai',
        status: 'sent',
        external_id: smsResult.sid,
        ai_generated: true,
        ai_confidence: agentResponse.confidence,
        ai_model: 'claude-sonnet-4-20250514',
        metadata: {
          agent: agentResponse.agent,
          action_taken: agentResponse.action_taken,
        },
      })
    } catch {
      // Fallback to legacy engagement generator if agent system fails
      try {
        const fallbackResponse = await generateLeadEngagement(lead, history, {
          mode: 'education',
          channel: 'sms',
        }, supabase)

        const smsResult = await sendSMS(from, fallbackResponse.message)

        await supabase.from('messages').insert({
          organization_id: lead.organization_id,
          conversation_id: conversation.id,
          lead_id: lead.id,
          direction: 'outbound',
          channel: 'sms',
          body: fallbackResponse.message,
          sender_type: 'ai',
          status: 'sent',
          external_id: smsResult.sid,
          ai_generated: true,
          ai_confidence: fallbackResponse.confidence,
          ai_model: 'claude-sonnet-4-20250514',
          metadata: { agent: 'fallback' },
        })
      } catch {
        // Complete failure — don't crash the webhook
      }
    }
  }

  // Return empty TwiML (we're handling response via API, not TwiML)
  return new NextResponse(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    { headers: { 'Content-Type': 'text/xml' } }
  )
}
