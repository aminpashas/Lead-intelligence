import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, requirePermission } from '@/lib/auth/active-org'
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
import { getOrgFlags } from '@/lib/org/flags'
import { isUsSmsBlocked, A2P_PENDING_MESSAGE } from '@/lib/messaging/a2p-gate'
import { recordAudit } from '@/lib/audit/record'
import { smsCampaignGate, logUnconsentedSmsSend } from '@/lib/consent/gate'

const massSMSSchema = z.object({
  smart_list_id: z.string().uuid().optional(),
  lead_ids: z.array(z.string().uuid()).optional(),
  message_template: z.string().min(1).max(1600),
  broadcast_name: z.string().optional(),
  // Re-permission override (manual bulk only): include consent-unknown leads.
  // Opted-out and declined leads are still excluded — see smsCampaignGate.
  // ⚠️ TCPA: no re-permission safe harbor for SMS; owner-authorized.
  allow_unconsented: z.boolean().optional().default(false),
})

export async function POST(request: NextRequest) {
  const rlError = await applyDistributedRateLimit(request, RATE_LIMITS.api, 'sms-mass')
  if (rlError) return rlError

  const supabase = await createClient()
  // Mass outbound is agency-side only. Practice staff can text a lead 1:1 from
  // the lead detail, but never blast the book — this gate is the boundary, not
  // the hidden nav item.
  const guard = await requirePermission(supabase, 'mass_sms:write')
  if ('error' in guard) return guard.error
  const { orgId } = guard

  // A2P 10DLC hard-block: refuse US SMS broadcasts until this org's 10DLC campaign
  // is verified (us_sms_enabled flag). Authoritative server gate; the composer also
  // surfaces this pre-emptively. Fail-closed via isUsSmsBlocked.
  const orgFlags = await getOrgFlags(supabase, orgId)
  if (isUsSmsBlocked(orgFlags)) {
    return NextResponse.json({ error: A2P_PENDING_MESSAGE, a2p_pending: true }, { status: 403 })
  }

  const body = await request.json()
  const parsed = massSMSSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const { smart_list_id, lead_ids: directLeadIds, message_template, broadcast_name, allow_unconsented } = parsed.data

  if (!smart_list_id && (!directLeadIds || directLeadIds.length === 0)) {
    return NextResponse.json({ error: 'Provide either smart_list_id or lead_ids' }, { status: 400 })
  }

  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id, full_name')

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

  // Filter to leads with a valid phone that pass the SMS campaign gate. Normally
  // that means affirmative consent + not opted out; with the re-permission override
  // (allow_unconsented) consent-UNKNOWN leads also pass, but opted-out and declined
  // leads never do. The authoritative per-send check re-runs inside sendSMSToLead.
  const sendable = leads.filter((l) => {
    const phone = decryptField(l.phone_formatted) || l.phone_formatted
    return phone && smsCampaignGate(l, { allowUnconsented: allow_unconsented }).allowed
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

      // Send via Twilio — authoritative TCPA consent gate per lead. When the
      // broadcast opted into re-permission, pass the override so consent-unknown
      // leads send (opted-out/declined still refused inside sendSMSToLead).
      const sendResult = await withRetry(
        () => sendSMSToLead({
          supabase,
          leadId: lead.id,
          to: phone,
          body: personalizedMessage,
          caller: 'api.sms.mass',
          allowUnconsented: allow_unconsented,
        }),
        RETRY_CONFIGS.twilio
      )

      if (!sendResult.sent) {
        results.skipped++
        deliveryLog.push({ lead_id: lead.id, lead_name: leadName, phone, status: 'skipped', error: `consent:${sendResult.reason}` })
        continue
      }
      const twilioResult = { sid: sendResult.sid }

      // Audit every send that went out only because of the re-permission override
      // (consent-unknown lead), so compliance can enumerate them later.
      const gate = smsCampaignGate(lead, { allowUnconsented: allow_unconsented })
      if (gate.allowed && gate.usedOverride) {
        await logUnconsentedSmsSend(supabase, {
          organizationId: orgId,
          leadId: lead.id,
          campaignId: campaign?.id || null,
          caller: 'sms.mass',
        })
      }

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

  // Audit trail: one summary event per mass-send request (not per-recipient).
  // A human with mass_sms:write clicked send, so this is a non-autonomous user action.
  void recordAudit(supabase, {
    organizationId: orgId,
    action: 'sms.mass_sent',
    actor: { actorType: 'user', actorId: profile.id, actorLabel: profile.full_name ?? null },
    source: 'api_route',
    resourceType: 'campaign',
    resourceId: campaign?.id ?? null,
    ai: { autonomous: false, approved_by: profile.id },
    metadata: {
      recipient_count: results.sent,
      total_targeted: results.total,
      failed: results.failed,
      skipped: results.skipped,
      smart_list_id: smart_list_id ?? null,
      allow_unconsented,
    },
  })

  // Persist the response so a duplicate retry returns it instead of re-sending.
  if (idempotencyKey) {
    await recordIdempotencyResponse(supabase, orgId, idempotencyKey, results)
  }

  return NextResponse.json(results)
}
