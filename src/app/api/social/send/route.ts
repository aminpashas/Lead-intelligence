import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { z } from 'zod'
import { applyDistributedRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { auditPHITransmission } from '@/lib/hipaa-audit'
import { assertActiveSubscription } from '@/lib/auth/entitlement'
import { getGhlConfig } from '@/lib/ghl/client'
import { sendGhlMessage } from '@/lib/ghl/conversations'
import { CHANNEL_META, SOCIAL_CHANNELS, type ConversationChannel } from '@/lib/channels'
import { checkSocialSend, classifyGhlSendError } from '@/lib/ghl/social-send-guards'

/**
 * Send a reply on a social DM channel (Facebook Messenger, Instagram).
 *
 * LI has no Meta connection of its own — GHL owns the Page integration, so the
 * reply is relayed through GHL's Conversations API. Requires the
 * `conversations/message.write` scope on the org's Private Integration Token.
 *
 * ── Why this is reply-only ──────────────────────────────────────────────────
 * `conversation_id` is REQUIRED and must already exist. There is deliberately
 * no find-or-create here (the SMS route has one), because that would let LI
 * *originate* a cold DM. Two reasons that must not be possible:
 *
 *   1. Consent. A patient DMing the practice page implies permission to answer
 *      in that thread — nothing more. LI's consent gate models sms/email/voice
 *      only; there is no social opt-out column to check, so the existence of an
 *      inbound thread IS the permission, and we require it structurally.
 *   2. Meta policy. Pages may reply to a person who messaged them; unsolicited
 *      outbound messaging is a different, restricted capability.
 */
const sendSocialSchema = z.object({
  lead_id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  channel: z.enum(SOCIAL_CHANNELS as [ConversationChannel, ...ConversationChannel[]]),
  message: z.string().min(1).max(2000),
  ai_generated: z.boolean().optional().default(false),
})

export async function POST(request: NextRequest) {
  const rlError = await applyDistributedRateLimit(request, RATE_LIMITS.api, 'social-send')
  if (rlError) return rlError

  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = sendSocialSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 },
    )
  }
  const { lead_id, conversation_id, channel, message, ai_generated } = parsed.data

  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id, full_name')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const entError = await assertActiveSubscription(supabase, orgId)
  if (entError) return entError

  // Fetch the rows the guards reason over. Both are org-scoped as
  // defense-in-depth beyond RLS.
  const { data: conversation } = await supabase
    .from('conversations')
    .select('id, channel, lead_id, status')
    .eq('id', conversation_id)
    .eq('organization_id', orgId)
    .single()

  const { data: lead } = await supabase
    .from('leads')
    .select('id, ghl_contact_id, organization_id')
    .eq('id', lead_id)
    .eq('organization_id', orgId)
    .single()

  const ghlConfig = await getGhlConfig(supabase, orgId)

  // All refusal rules live in one pure, unit-tested place (social-send-guards).
  const refusal = checkSocialSend({
    conversation,
    lead,
    leadId: lead_id,
    channel,
    ghlConfigured: Boolean(ghlConfig),
  })
  if (refusal) {
    return NextResponse.json(
      { error: refusal.error, reason: refusal.reason },
      { status: refusal.status },
    )
  }

  // Non-null past the guards, but narrow for TypeScript.
  if (!conversation || !lead?.ghl_contact_id || !ghlConfig) {
    return NextResponse.json({ error: 'Precondition failed' }, { status: 409 })
  }
  const ghlSendType = CHANNEL_META[channel].ghlSendType as string

  try {
    // HIPAA: the message body leaves our boundary for GHL/Meta. Awaited so an
    // audit-write failure fails the send closed rather than losing the record.
    await auditPHITransmission(
      { supabase, organizationId: lead.organization_id, actorId: profile.id },
      'lead',
      lead.id,
      `GHL ${CHANNEL_META[channel].label}`,
      ['name'],
    )

    // No retry wrapper: a send is not idempotent and GHL returns no idempotency
    // key, so a retry risks the patient receiving the same DM twice.
    const result = await sendGhlMessage(ghlConfig, {
      type: ghlSendType,
      contactId: lead.ghl_contact_id,
      message,
      // GHL accepts the conversation id, but ours is an LI uuid — the GHL-side
      // thread is resolved from contactId + type, so it is intentionally omitted.
    })

    const { data: stored } = await supabase
      .from('messages')
      .insert({
        organization_id: orgId,
        conversation_id: conversation.id,
        lead_id: lead.id,
        direction: 'outbound',
        channel,
        body: message,
        sender_type: ai_generated ? 'ai' : 'user',
        sender_id: profile.id,
        sender_name: profile.full_name,
        status: 'sent',
        // Namespaced identically to the ingest path, so when the GHL sweep
        // re-reads this same message it dedups instead of duplicating it.
        external_id: result.messageId ? `ghl_msg:${result.messageId}` : null,
        ai_generated,
        attachments: [],
        metadata: { source: 'li', sent_via: 'ghl', ghl_conversation_id: result.conversationId ?? null },
      })
      .select()
      .single()

    // A staff reply closes the response-SLA timer, same as the SMS path.
    if (!ai_generated) {
      import('@/lib/automation/sla')
        .then(({ closeSlaOnHumanReply }) =>
          closeSlaOnHumanReply(createServiceClient(), conversation.id, profile.id),
        )
        .catch(() => { /* non-critical SLA bookkeeping */ })
    }

    await supabase.from('lead_activities').insert({
      organization_id: orgId,
      lead_id: lead.id,
      user_id: profile.id,
      // Matches the sms_sent / email_sent convention so activity can be filtered
      // per channel. (The column's CHECK is a `^[a-z][a-z0-9_]*$` regex, not an
      // enum, so a new channel needs no migration.)
      activity_type: `${channel}_sent`,
      title: `${CHANNEL_META[channel].label} reply sent`,
      description: message.substring(0, 200),
    })

    await supabase
      .from('leads')
      .update({ last_contacted_at: new Date().toISOString() })
      .eq('id', lead.id)

    return NextResponse.json({ message: stored, ghl_message_id: result.messageId ?? null })
  } catch (err) {
    const raw = err instanceof Error ? err.message : 'Failed to send message'
    const failure = classifyGhlSendError(raw)
    return NextResponse.json(
      { error: failure.error, reason: failure.reason },
      { status: failure.status },
    )
  }
}
