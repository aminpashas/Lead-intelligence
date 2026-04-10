import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { exitCampaignsOnReply } from '@/lib/campaigns/enrollments'
import { routeToAgent, getHandoffHistory } from '@/lib/ai/agent-handoff'
import { getPatientProfile } from '@/lib/ai/patient-psychology'
import { sendEmail } from '@/lib/messaging/resend'
import type { AgentContext, ConversationMessage } from '@/lib/ai/agent-types'
import type { PatientProfile, ConversationChannel, LeadStatus } from '@/types/database'
import crypto from 'crypto'

/**
 * Resend Webhook Event Types:
 * - email.sent — Email accepted by Resend
 * - email.delivered — Email delivered to recipient
 * - email.opened — Recipient opened the email
 * - email.clicked — Recipient clicked a link
 * - email.bounced — Email bounced
 * - email.complained — Recipient marked as spam
 * - email.delivery_delayed — Delivery delayed
 */

type ResendWebhookEvent = {
  type: string
  created_at: string
  data: {
    email_id: string
    from: string
    to: string[]
    subject: string
    created_at: string
    // For click events
    click?: { link: string; timestamp: string }
    // For bounce events
    bounce?: { message: string; type: string }
  }
}

// Verify Resend webhook signature (Svix-based)
function verifyResendSignature(rawBody: string, headers: Headers): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET
  if (!secret) return false

  const signatureHeader = headers.get('svix-signature')
  const timestampHeader = headers.get('svix-timestamp')
  const idHeader = headers.get('svix-id')

  if (!signatureHeader || !timestampHeader || !idHeader) return false

  // Check timestamp isn't too old (5 minutes tolerance)
  const timestamp = parseInt(timestampHeader, 10)
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - timestamp) > 300) return false

  // Compute expected signature
  const toSign = `${idHeader}.${timestampHeader}.${rawBody}`
  // Resend uses base64-encoded secret with "whsec_" prefix
  const secretBytes = Buffer.from(secret.replace('whsec_', ''), 'base64')
  const expectedSignature = crypto
    .createHmac('sha256', secretBytes)
    .update(toSign)
    .digest('base64')

  // Svix sends multiple signatures separated by space, prefixed with "v1,"
  const signatures = signatureHeader.split(' ')
  return signatures.some((sig) => {
    const sigValue = sig.replace('v1,', '')
    try {
      return crypto.timingSafeEqual(
        Buffer.from(sigValue, 'base64'),
        Buffer.from(expectedSignature, 'base64')
      )
    } catch {
      return false
    }
  })
}

// POST /api/webhooks/resend — Incoming email events from Resend
export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.webhook)
  if (rlError) return rlError

  const rawBody = await request.text()

  // Verify signature (skip in development if no secret configured)
  const hasSecret = !!(process.env.RESEND_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET)
  if (hasSecret && !verifyResendSignature(rawBody, request.headers)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let event: ResendWebhookEvent
  try {
    event = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const emailId = event.data?.email_id

  if (!emailId) {
    return NextResponse.json({ error: 'Missing email_id' }, { status: 400 })
  }

  // Look up the original message by Resend email ID
  const { data: message } = await supabase
    .from('messages')
    .select('id, organization_id, conversation_id, lead_id, direction, channel')
    .eq('external_id', emailId)
    .single()

  if (!message) {
    // Not a tracked email — might be from another system
    return NextResponse.json({ ok: true, skipped: 'message not found' })
  }

  const { organization_id: orgId, conversation_id: convoId, lead_id: leadId } = message

  switch (event.type) {
    case 'email.delivered': {
      await supabase.from('messages').update({ status: 'delivered' }).eq('id', message.id)

      // Update campaign step stats
      await updateCampaignStepStats(supabase, convoId, leadId, 'delivered')
      break
    }

    case 'email.opened': {
      await supabase.from('messages').update({
        status: 'read',
        opened_at: event.created_at,
      }).eq('id', message.id)

      // Update campaign step stats
      await updateCampaignStepStats(supabase, convoId, leadId, 'opened')

      // Log activity
      await supabase.from('lead_activities').insert({
        organization_id: orgId,
        lead_id: leadId,
        activity_type: 'email_opened',
        title: 'Opened email',
        metadata: { message_id: message.id, email_id: emailId },
      })
      break
    }

    case 'email.clicked': {
      await supabase.from('messages').update({
        clicked_at: event.created_at,
      }).eq('id', message.id)

      // Log activity
      await supabase.from('lead_activities').insert({
        organization_id: orgId,
        lead_id: leadId,
        activity_type: 'email_clicked',
        title: 'Clicked link in email',
        metadata: { message_id: message.id, link: event.data.click?.link },
      })
      break
    }

    case 'email.bounced': {
      await supabase.from('messages').update({ status: 'bounced' }).eq('id', message.id)

      // Mark lead's email as invalid
      await supabase.from('leads').update({
        email_opt_out: true,
        email_opt_out_at: new Date().toISOString(),
      }).eq('id', leadId)

      // Exit campaigns
      await exitCampaignsOnReply(supabase, leadId, orgId)

      // Log activity
      await supabase.from('lead_activities').insert({
        organization_id: orgId,
        lead_id: leadId,
        activity_type: 'email_bounced',
        title: 'Email bounced',
        metadata: { message_id: message.id, bounce: event.data.bounce },
      })
      break
    }

    case 'email.complained': {
      // Spam complaint — opt out immediately
      await supabase.from('messages').update({ status: 'failed' }).eq('id', message.id)

      await supabase.from('leads').update({
        email_opt_out: true,
        email_opt_out_at: new Date().toISOString(),
      }).eq('id', leadId)

      // Exit all campaigns
      await exitCampaignsOnReply(supabase, leadId, orgId)

      await supabase.from('lead_activities').insert({
        organization_id: orgId,
        lead_id: leadId,
        activity_type: 'email_complained',
        title: 'Email marked as spam',
        metadata: { message_id: message.id },
      })
      break
    }

    case 'email.delivery_delayed': {
      await supabase.from('messages').update({ status: 'queued' }).eq('id', message.id)
      break
    }

    case 'email.sent': {
      // Already tracked on send — just confirm
      await supabase.from('messages').update({ status: 'sent' }).eq('id', message.id)
      break
    }
  }

  return NextResponse.json({ ok: true, event: event.type })
}

/**
 * Update campaign step stats when email events occur.
 */
async function updateCampaignStepStats(
  supabase: ReturnType<typeof createServiceClient>,
  conversationId: string,
  leadId: string,
  eventType: 'delivered' | 'opened' | 'replied'
): Promise<void> {
  // Find active enrollment for this lead
  const { data: enrollment } = await supabase
    .from('campaign_enrollments')
    .select('id, campaign_id, current_step')
    .eq('lead_id', leadId)
    .eq('status', 'active')
    .limit(1)
    .single()

  if (!enrollment) return

  // Find the step
  const { data: step } = await supabase
    .from('campaign_steps')
    .select('id, total_delivered, total_opened, total_replied')
    .eq('campaign_id', enrollment.campaign_id)
    .eq('step_number', enrollment.current_step)
    .single()

  if (!step) return

  const updates: Record<string, number> = {}
  if (eventType === 'delivered') updates.total_delivered = (step.total_delivered || 0) + 1
  if (eventType === 'opened') updates.total_opened = (step.total_opened || 0) + 1
  if (eventType === 'replied') updates.total_replied = (step.total_replied || 0) + 1

  if (Object.keys(updates).length > 0) {
    await supabase.from('campaign_steps').update(updates).eq('id', step.id)
  }
}
