import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { sendSMS, validateTwilioWebhook } from '@/lib/messaging/twilio'
import { applyDistributedRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { exitCampaignsOnReply } from '@/lib/campaigns/enrollments'
import { searchHash } from '@/lib/encryption'
import { logger } from '@/lib/logger'

// POST /api/webhooks/twilio - Incoming SMS from Twilio
export async function POST(request: NextRequest) {
  // Rate limit
  const rlError = await applyDistributedRateLimit(request, RATE_LIMITS.webhook, 'wh-twilio')
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

  // ── SMS TRAINING CONSOLE ──
  // Training is opt-in per message: the module only owns an inbound SMS when the
  // trainer has an active session OR sends an explicit command (TRAIN/ROLEPLAY/
  // RULE/HELP/STATUS). Otherwise handled=false and a trainer number falls through
  // to the normal lead pipeline, so it can still text in as a real patient.
  const { handleTrainerSms } = await import('@/lib/autopilot/sms-training')
  const training = await handleTrainerSms(supabase, { from, body })
  if (training.handled) {
    const reply = training.reply
      ? `<Message>${training.reply.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</Message>`
      : ''
    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response>${reply}</Response>`,
      { headers: { 'Content-Type': 'text/xml' } }
    )
  }

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
  // Sanitize phone input to prevent PostgREST filter injection
  if (!lead) {
    const sanitizedFrom = from.replace(/[^+0-9]/g, '')
    if (sanitizedFrom) {
      const { data } = await supabase
        .from('leads')
        .select('*, organization_id')
        .or(`phone_formatted.eq.${sanitizedFrom},phone.eq.${sanitizedFrom}`)
        .limit(1)
        .single()
      lead = data
    }
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

  // ── APPOINTMENT CONFIRMATION via SMS ──
  // Detect YES/CONFIRM/Y and auto-confirm the next upcoming unconfirmed appointment
  const confirmKeywords = /^\s*(yes|confirm|y|confirmed|yep|yeah)\s*$/i
  if (confirmKeywords.test(body)) {
    // Check for an upcoming unconfirmed appointment
    const { data: pendingApt } = await supabase
      .from('appointments')
      .select('id, type, scheduled_at')
      .eq('lead_id', lead.id)
      .eq('organization_id', lead.organization_id)
      .in('status', ['scheduled'])
      .eq('confirmation_received', false)
      .gte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(1)
      .single()

    if (pendingApt) {
      // Confirm the appointment
      const { confirmAppointment } = await import('@/lib/campaigns/reminders')
      await confirmAppointment(supabase, pendingApt.id, 'sms_reply', lead.organization_id)

      logger.info('Appointment confirmed via SMS reply', {
        leadId: lead.id,
        appointmentId: pendingApt.id,
      })

      // Return confirmation TwiML — don't fall through to re-subscribe
      return new NextResponse(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        { headers: { 'Content-Type': 'text/xml' } }
      )
    }
    // No pending appointment — fall through to re-subscribe handler below
  }

  // TCPA: Handle re-subscribe (START)
  const optInKeywords = /^\s*(start|subscribe)\s*$/i
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

  // Store inbound message (id captured for the D3 response-SLA row)
  const { data: inboundMessage } = await supabase
    .from('messages')
    .insert({
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
    .select('id')
    .single()

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: lead.organization_id,
    lead_id: lead.id,
    activity_type: 'sms_received',
    title: 'SMS received',
    description: body.substring(0, 200),
  })

  // Update lead engagement stats (atomic increment to prevent race conditions)
  await supabase.rpc('increment_lead_sms_received', { p_lead_id: lead.id })

  // Update conversation stats (atomic increment)
  await supabase.rpc('increment_conversation_counters', {
    p_conversation_id: conversation.id,
    p_last_message_preview: body.substring(0, 100),
  })

  // Exit campaigns with if_replied exit condition
  await exitCampaignsOnReply(supabase, lead.id, lead.organization_id)

  // Extract financial signals from inbound message (non-blocking)
  import('@/lib/ai/financial-qualifier')
    .then(({ processFinancialSignals }) =>
      processFinancialSignals(supabase, lead.id, lead.organization_id, body, lead)
    )
    .catch(() => { /* Non-critical — don't block message flow */ })

  // Detect competitor mentions (Phase 4, non-blocking, gated by competitor_intel flag)
  Promise.all([import('@/lib/org/flags'), import('@/lib/competitive/context')])
    .then(async ([{ isFlagEnabled }, { persistCompetitorMentions }]) => {
      if (await isFlagEnabled(supabase, lead.organization_id, 'competitor_intel')) {
        await persistCompetitorMentions(supabase, {
          leadId: lead.id,
          organizationId: lead.organization_id,
          text: body,
        })
      }
    })
    .catch(() => { /* Non-critical — don't block message flow */ })

  // Auto-respond with AI autopilot system
  if (conversation.ai_enabled) {
    const { processAutoResponse } = await import('@/lib/autopilot/auto-respond')

    const result = await processAutoResponse(supabase, {
      organization_id: lead.organization_id,
      conversation_id: conversation.id,
      lead_id: lead.id,
      lead,
      conversation,
      inbound_message: body,
      channel: 'sms',
      sender_contact: from,
    })

    logger.info('Autopilot auto-response result', {
      leadId: lead.id,
      conversationId: conversation.id,
      action: result.action,
      reason: result.reason,
      confidence: result.confidence,
    })

    // ── D3: response-SLA bookkeeping ──
    // 'hold' → open the takeover timer (the sla-takeover cron enforces it);
    // AI sent → stamp the first-response metrics row. Best-effort: SLA writes
    // must never fail the webhook response.
    try {
      const { openResponseSla, recordImmediateAiResponse } = await import('@/lib/automation/sla')
      if (
        result.action === 'held_for_human' &&
        result.allocation?.owner === 'hold' &&
        result.allocation.slaSeconds
      ) {
        await openResponseSla(supabase, {
          organizationId: lead.organization_id,
          conversationId: conversation.id,
          leadId: lead.id,
          inboundMessageId: inboundMessage?.id ?? null,
          slaSeconds: result.allocation.slaSeconds,
          takeoverPayload: {
            organization_id: lead.organization_id,
            conversation_id: conversation.id,
            lead_id: lead.id,
            inbound_message: body,
            channel: 'sms',
            sender_contact: from,
          },
        })
        // TODO(D5: notifyInboundMessage): alert the assignee pool that a lead
        // is waiting on a human reply with an SLA running.
      } else if (result.action === 'sent') {
        await recordImmediateAiResponse(supabase, {
          organizationId: lead.organization_id,
          conversationId: conversation.id,
          leadId: lead.id,
          inboundMessageId: inboundMessage?.id ?? null,
        })
      }
    } catch (err) {
      logger.warn('SLA bookkeeping failed (webhook unaffected)', {
        conversationId: conversation.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Refresh the rolling conversation summary in the background.
  // Debounced to MIN_NEW_MESSAGES inside summarizeConversation; safe to call after every inbound.
  import('@/lib/ai/summarize')
    .then(({ summarizeConversation }) =>
      summarizeConversation(supabase, {
        conversationId: conversation.id,
        organizationId: lead.organization_id,
        leadId: lead.id,
      })
    )
    .catch(() => { /* observability-only; never blocks the webhook */ })

  // Return empty TwiML (we're handling response via API, not TwiML)
  return new NextResponse(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    { headers: { 'Content-Type': 'text/xml' } }
  )
}
