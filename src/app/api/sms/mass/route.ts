import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { z } from 'zod'
import { applyDistributedRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { withRetry, RETRY_CONFIGS } from '@/lib/retry'
import { decryptField } from '@/lib/encryption'
import { resolveSmartListLeads } from '@/lib/campaigns/smart-list-resolver'
import { personalize, PERSONALIZABLE_LEAD_SELECT, type PersonalizableLead } from '@/lib/campaigns/personalization'
import { claimIdempotencyKey, recordIdempotencyResponse, countTodaysOutbound, DAILY_SMS_CAP } from '@/lib/messaging/send-guards'
import { assertActiveSubscription } from '@/lib/auth/entitlement'

const massSMSSchema = z.object({
  smart_list_id: z.string().uuid().optional(),
  lead_ids: z.array(z.string().uuid()).optional(),
  message_template: z.string().min(1).max(1600),
  broadcast_name: z.string().optional(),
})

export async function POST(request: NextRequest) {
  const rlError = await applyDistributedRateLimit(request, RATE_LIMITS.api, 'sms-mass')
  if (rlError) return rlError

  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json()
  const parsed = massSMSSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const { smart_list_id, lead_ids: directLeadIds, message_template, broadcast_name } = parsed.data

  if (!smart_list_id && (!directLeadIds || directLeadIds.length === 0)) {
    return NextResponse.json({ error: 'Provide either smart_list_id or lead_ids' }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id, full_name')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const entError = await assertActiveSubscription(supabase, orgId)
  if (entError) return entError

  // Idempotency: a retried POST carrying the same Idempotency-Key must not re-send.
  const idempotencyKey = request.headers.get('Idempotency-Key') || request.headers.get('idempotency-key')
  if (idempotencyKey) {
    const claim = await claimIdempotencyKey(supabase, orgId, idempotencyKey, 'sms.mass')
    if (!claim.claimed) {
      return NextResponse.json(
        claim.response ?? { error: 'Duplicate request — this Idempotency-Key was already processed', duplicate: true },
        { status: claim.response ? 200 : 409 }
      )
    }
  }

  // Resolve target leads
  let targetLeadIds: string[] = []

  if (smart_list_id) {
    const { data: smartList } = await supabase
      .from('smart_lists')
      .select('criteria')
      .eq('id', smart_list_id)
      .eq('organization_id', orgId)
      .single()

    if (!smartList) {
      return NextResponse.json({ error: 'Smart List not found' }, { status: 404 })
    }

    const { leadIds } = await resolveSmartListLeads(
      supabase,
      orgId,
      smartList.criteria,
      { limit: 2000 }
    )
    targetLeadIds = leadIds
  } else {
    targetLeadIds = directLeadIds || []
  }

  if (targetLeadIds.length === 0) {
    return NextResponse.json({ error: 'No matching leads found' }, { status: 400 })
  }

  // Fetch leads with full personalizable data
  const { data: leadsRaw } = await supabase
    .from('leads')
    .select(PERSONALIZABLE_LEAD_SELECT)
    .in('id', targetLeadIds.slice(0, 2000))
    .eq('organization_id', orgId)

  const leads = (leadsRaw || []) as unknown as PersonalizableLead[]

  if (leads.length === 0) {
    return NextResponse.json({ error: 'No leads found' }, { status: 400 })
  }

  // Filter to leads with valid phone AND affirmative SMS consent AND not opted out.
  // The authoritative TCPA check happens per-send in sendSMSToLead; this pre-filter
  // avoids creating conversations / personalizing for leads we can't legally text.
  const sendable = leads.filter((l) => {
    const phone = decryptField(l.phone_formatted) || l.phone_formatted
    return phone && l.sms_consent === true && !l.sms_opt_out
  })

  if (sendable.length === 0) {
    return NextResponse.json({ error: 'No sendable leads (no SMS consent, opted out, or missing phone)' }, { status: 400 })
  }

  // Per-org daily SMS cap (real-money guardrail). Trim observably rather than
  // silently — the response reports how many were dropped.
  const sentToday = await countTodaysOutbound(supabase, orgId, 'sms')
  const remainingToday = Math.max(0, DAILY_SMS_CAP - sentToday)
  if (remainingToday === 0) {
    return NextResponse.json(
      { error: 'Daily SMS limit reached for this organization', daily_cap: DAILY_SMS_CAP, sent_today: sentToday },
      { status: 429 }
    )
  }
  const capped = sendable.length > remainingToday
  const recipients = capped ? sendable.slice(0, remainingToday) : sendable

  // Create broadcast campaign for tracking
  const { data: campaign } = await supabase
    .from('campaigns')
    .insert({
      organization_id: orgId,
      created_by: profile.id,
      name: broadcast_name || `Mass SMS — ${new Date().toLocaleDateString()}`,
      type: 'broadcast',
      channel: 'sms',
      status: 'active',
      smart_list_id: smart_list_id || null,
      total_enrolled: recipients.length,
    })
    .select('id')
    .single()

  // Per-lead results for audit trail
  const deliveryLog: {
    lead_id: string
    lead_name: string
    phone: string
    status: 'sent' | 'failed' | 'skipped'
    error?: string
    sent_at?: string
    message_preview?: string
  }[] = []

  const results = {
    total: recipients.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    capped,
    dropped_for_daily_cap: capped ? sendable.length - recipients.length : 0,
    daily_cap: DAILY_SMS_CAP,
    errors: [] as { lead_id: string; error: string }[],
    campaign_id: campaign?.id || null,
    delivery_log: deliveryLog,
  }

  for (const lead of recipients) {
    const phone = decryptField(lead.phone_formatted) || lead.phone_formatted || ''
    const leadName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'Unknown'

    try {
      // Personalize message using the full engine
      const personalizedMessage = personalize(message_template, lead)

      // Find or create conversation
      let conversationId: string

      const { data: existingConvo } = await supabase
        .from('conversations')
        .select('id')
        .eq('lead_id', lead.id)
        .eq('channel', 'sms')
        .eq('status', 'active')
        .limit(1)
        .single()

      if (existingConvo) {
        conversationId = existingConvo.id
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
        conversationId = newConvo?.id || ''
      }

      if (!conversationId) {
        results.failed++
        results.errors.push({ lead_id: lead.id, error: 'Failed to create conversation' })
        deliveryLog.push({ lead_id: lead.id, lead_name: leadName, phone, status: 'failed', error: 'Failed to create conversation' })
        continue
      }

      // Send via Twilio — authoritative TCPA consent gate per lead.
      const sendResult = await withRetry(
        () => sendSMSToLead({
          supabase,
          leadId: lead.id,
          to: phone,
          body: personalizedMessage,
          caller: 'api.sms.mass',
        }),
        RETRY_CONFIGS.twilio
      )

      if (!sendResult.sent) {
        results.skipped++
        deliveryLog.push({ lead_id: lead.id, lead_name: leadName, phone, status: 'skipped', error: `consent:${sendResult.reason}` })
        continue
      }
      const twilioResult = { sid: sendResult.sid }

      // Store message
      await supabase.from('messages').insert({
        organization_id: orgId,
        conversation_id: conversationId,
        lead_id: lead.id,
        direction: 'outbound',
        channel: 'sms',
        body: personalizedMessage,
        sender_type: 'user',
        sender_id: profile.id,
        sender_name: profile.full_name,
        status: 'sent',
        external_id: twilioResult.sid,
        ai_generated: false,
        metadata: { broadcast: true, campaign_id: campaign?.id },
      })

      results.sent++
      deliveryLog.push({
        lead_id: lead.id,
        lead_name: leadName,
        phone,
        status: 'sent',
        sent_at: new Date().toISOString(),
        message_preview: personalizedMessage.substring(0, 80),
      })
    } catch (err) {
      results.failed++
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      results.errors.push({ lead_id: lead.id, error: errorMsg })
      deliveryLog.push({ lead_id: lead.id, lead_name: leadName, phone, status: 'failed', error: errorMsg })
    }
  }

  // Update campaign stats
  if (campaign) {
    await supabase
      .from('campaigns')
      .update({
        total_completed: results.sent,
        status: 'completed',
        metadata: {
          delivery_log: deliveryLog,
          message_template,
          broadcast_name,
          smart_list_id,
        },
      })
      .eq('id', campaign.id)
  }

  // Persist the response so a duplicate retry returns it instead of re-sending.
  if (idempotencyKey) {
    await recordIdempotencyResponse(supabase, orgId, idempotencyKey, results)
  }

  return NextResponse.json(results)
}
