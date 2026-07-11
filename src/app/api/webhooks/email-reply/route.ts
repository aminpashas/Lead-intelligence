import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { applyDistributedRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { exitCampaignsOnReply } from '@/lib/campaigns/enrollments'
import { searchHash } from '@/lib/encryption'

function timingSafeBearer(authHeader: string | null, secret: string | undefined): boolean {
  if (!secret) return false // fail-closed: never accept when no secret is configured
  const expected = `Bearer ${secret}`
  const a = Buffer.from(authHeader ?? '')
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * POST /api/webhooks/email-reply — Inbound email replies
 *
 * Accepts forwarded email replies (from Resend inbound, Mailgun, SendGrid, etc.)
 * Body format: { from, to, subject, body, html_body?, in_reply_to?, message_id? }
 *
 * This handles:
 * 1. Finding the lead by email
 * 2. Storing the inbound message
 * 3. Updating conversation stats
 * 4. Exiting campaigns with if_replied condition
 * 5. Logging activity
 */

export async function POST(request: NextRequest) {
  const rlError = await applyDistributedRateLimit(request, RATE_LIMITS.webhook, 'wh-email-reply')
  if (rlError) return rlError

  // Verify webhook secret (fail-closed if WEBHOOK_SECRET is unset; timing-safe).
  if (!timingSafeBearer(request.headers.get('authorization'), process.env.WEBHOOK_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { from, subject, body: emailBody, html_body, in_reply_to, message_id } = body

  if (!from || !emailBody) {
    return NextResponse.json({ error: 'Missing from or body' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Extract email address from "Name <email>" format
  const emailMatch = from.match(/<([^>]+)>/) || [null, from]
  const senderEmail = (emailMatch[1] || from).toLowerCase().trim()

  // Find lead by email (try encrypted hash first, then plaintext fallback)
  let lead: Record<string, unknown> | null = null
  const emailHash = searchHash(senderEmail)
  if (emailHash) {
    const { data } = await supabase
      .from('leads')
      .select('*, organization_id')
      .eq('email_hash', emailHash)
      .limit(1)
      .single()
    lead = data
  }
  if (!lead) {
    const { data } = await supabase
      .from('leads')
      .select('*, organization_id')
      .eq('email', senderEmail)
      .limit(1)
      .single()
    lead = data
  }

  if (!lead) {
    return NextResponse.json({ ok: true, skipped: 'lead not found' })
  }

  const orgId = lead.organization_id as string
  const leadId = lead.id as string

  // Find or create conversation
  let conversation: Record<string, unknown> | null = null
  const { data: existingConvo } = await supabase
    .from('conversations')
    .select('*')
    .eq('lead_id', leadId)
    .eq('channel', 'email')
    .eq('status', 'active')
    .limit(1)
    .single()

  if (existingConvo) {
    conversation = existingConvo
  } else {
    const { data: newConvo } = await supabase
      .from('conversations')
      .insert({
        organization_id: orgId,
        lead_id: leadId,
        channel: 'email',
        status: 'active',
        ai_enabled: true,
        ai_mode: 'assist',
        subject: subject || 'Email reply',
      })
      .select()
      .single()
    conversation = newConvo
  }

  if (!conversation) {
    return NextResponse.json({ error: 'Failed to find/create conversation' }, { status: 500 })
  }

  const convoId = conversation.id as string

  // Store inbound message (id captured for the D3 response-SLA row)
  const { data: inboundMessage } = await supabase
    .from('messages')
    .insert({
      organization_id: orgId,
      conversation_id: convoId,
      lead_id: leadId,
      direction: 'inbound',
      channel: 'email',
      body: emailBody,
      html_body: html_body || null,
      subject: subject || null,
      sender_type: 'lead',
      sender_name: from,
      status: 'delivered',
      external_id: message_id || null,
      metadata: { in_reply_to },
    })
    .select('id')
    .single()

  // Update lead engagement stats (atomic increment to prevent race conditions)
  await supabase.rpc('increment_lead_messages_received', { p_lead_id: leadId })

  // Update conversation stats (atomic increment)
  await supabase.rpc('increment_conversation_counters', {
    p_conversation_id: convoId,
    p_last_message_preview: emailBody.substring(0, 100),
  })

  // Exit campaigns with if_replied exit condition
  await exitCampaignsOnReply(supabase, leadId, orgId)

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: orgId,
    lead_id: leadId,
    activity_type: 'email_received',
    title: 'Email reply received',
    description: emailBody.substring(0, 200),
    metadata: { conversation_id: convoId, subject },
  })

  // Auto-respond with AI autopilot system
  if (conversation.ai_enabled) {
    const { processAutoResponse } = await import('@/lib/autopilot/auto-respond')

    const result = await processAutoResponse(supabase, {
      organization_id: orgId,
      conversation_id: convoId,
      lead_id: leadId,
      lead,
      conversation,
      inbound_message: emailBody,
      channel: 'email',
      sender_contact: senderEmail,
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
          organizationId: orgId,
          conversationId: convoId,
          leadId,
          inboundMessageId: inboundMessage?.id ?? null,
          slaSeconds: result.allocation.slaSeconds,
          takeoverPayload: {
            organization_id: orgId,
            conversation_id: convoId,
            lead_id: leadId,
            inbound_message: emailBody,
            channel: 'email',
            sender_contact: senderEmail,
          },
        })
        // TODO(D5: notifyInboundMessage): alert the assignee pool that a lead
        // is waiting on a human reply with an SLA running.
      } else if (result.action === 'sent') {
        await recordImmediateAiResponse(supabase, {
          organizationId: orgId,
          conversationId: convoId,
          leadId,
          inboundMessageId: inboundMessage?.id ?? null,
        })
      }
    } catch {
      /* SLA bookkeeping is best-effort — never fail the webhook */
    }
  }

  return NextResponse.json({ ok: true, conversation_id: convoId })
}
