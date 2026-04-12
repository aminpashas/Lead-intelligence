import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { exitCampaignsOnReply } from '@/lib/campaigns/enrollments'
import { searchHash } from '@/lib/encryption'

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
  const rlError = applyRateLimit(request, RATE_LIMITS.webhook)
  if (rlError) return rlError

  // Verify webhook secret
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.WEBHOOK_SECRET}`) {
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

  // Store inbound message
  await supabase.from('messages').insert({
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

  return NextResponse.json({ ok: true, conversation_id: convoId })
}
