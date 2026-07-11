import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { z } from 'zod'
import { applyDistributedRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { withRetry, RETRY_CONFIGS } from '@/lib/retry'
import { decryptField } from '@/lib/encryption'
import { auditPHITransmission } from '@/lib/hipaa-audit'
import { assertActiveSubscription } from '@/lib/auth/entitlement'

const sendSMSSchema = z.object({
  lead_id: z.string().uuid(),
  message: z.string().min(1).max(1600),
  ai_generated: z.boolean().optional().default(false),
})

export async function POST(request: NextRequest) {
  const rlError = await applyDistributedRateLimit(request, RATE_LIMITS.api, 'sms-send')
  if (rlError) return rlError

  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json()
  const parsed = sendSMSSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  // Get user profile
  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id, full_name')

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const entError = await assertActiveSubscription(supabase, orgId)
  if (entError) return entError

  // Get lead — scoped to caller's org (defense-in-depth beyond RLS)
  const { data: lead } = await supabase
    .from('leads')
    .select('id, phone_formatted, phone, first_name, last_name, organization_id')
    .eq('id', parsed.data.lead_id)
    .eq('organization_id', orgId)
    .single()

  if (!lead || !lead.phone_formatted) {
    return NextResponse.json({ error: 'Lead not found or has no phone number' }, { status: 404 })
  }

  // Decrypt PII fields
  lead.phone_formatted = decryptField(lead.phone_formatted) || lead.phone_formatted

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
        organization_id: orgId,
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
    // HIPAA audit: PHI transmitted to Twilio. Awaited so an audit-write failure
    // fails the send closed rather than silently dropping the disclosure record.
    await auditPHITransmission(
      { supabase, organizationId: lead.organization_id, actorId: profile.id },
      'lead',
      lead.id,
      'Twilio SMS',
      ['phone'],
    )

    // Send via Twilio — HARD consent gate (TCPA). Refuses if the lead has not
    // granted SMS consent or has opted out, and logs a consent_violation_prevented row.
    const sendResult = await withRetry(
      () => sendSMSToLead({
        supabase,
        leadId: lead.id,
        to: lead.phone_formatted,
        body: parsed.data.message,
        caller: 'api.sms.send',
        aiGenerated: parsed.data.ai_generated,
        // Human-authored 1:1 reply from the dashboard — exempt from quiet-hours
        // (still consent-gated). Automated paths do NOT set this.
        bypassQuietHours: !parsed.data.ai_generated,
        // Attribute the audit row to the staff member, not the generic `system` actor.
        actor: { id: profile.id, label: profile.full_name },
      }),
      RETRY_CONFIGS.twilio
    )

    if (!sendResult.sent) {
      return NextResponse.json(
        { error: 'Message blocked', reason: sendResult.reason },
        { status: 403 }
      )
    }
    const result = { sid: sendResult.sid }

    // Store message
    const { data: message } = await supabase
      .from('messages')
      .insert({
        organization_id: orgId,
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

    // D3: a staff-authored reply closes the response-SLA timer and the live
    // inbound task. Service client — message_response_slas writes are
    // service-role only. Best-effort: never blocks or fails the send response.
    if (!parsed.data.ai_generated) {
      import('@/lib/automation/sla')
        .then(({ closeSlaOnHumanReply }) =>
          closeSlaOnHumanReply(createServiceClient(), conversation.id, profile.id)
        )
        .catch(() => { /* non-critical SLA bookkeeping */ })
    }

    // Log activity
    await supabase.from('lead_activities').insert({
      organization_id: orgId,
      lead_id: lead.id,
      user_id: profile.id,
      activity_type: 'sms_sent',
      title: 'SMS sent',
      description: parsed.data.message.substring(0, 200),
    })

    // Update lead engagement metrics (unified with Voice/Email)
    await supabase.from('leads').update({
      last_contacted_at: new Date().toISOString(),
      total_sms_sent: (lead as Record<string, unknown>).total_sms_sent
        ? ((lead as Record<string, unknown>).total_sms_sent as number) + 1
        : 1,
    }).eq('id', lead.id)

    return NextResponse.json({ message, twilio_sid: result.sid })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to send SMS'
    return NextResponse.json({ error: errorMsg }, { status: 500 })
  }
}
