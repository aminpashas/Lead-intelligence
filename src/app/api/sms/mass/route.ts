import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendSMS } from '@/lib/messaging/twilio'
import { z } from 'zod'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { withRetry, RETRY_CONFIGS } from '@/lib/retry'
import { decryptField } from '@/lib/encryption'
import { resolveSmartListLeads } from '@/lib/campaigns/smart-list-resolver'

const massSMSSchema = z.object({
  // Provide either smart_list_id or lead_ids
  smart_list_id: z.string().uuid().optional(),
  lead_ids: z.array(z.string().uuid()).optional(),
  message_template: z.string().min(1).max(1600),
  // Optional: name for tracking this broadcast
  broadcast_name: z.string().optional(),
})

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()
  const body = await request.json()
  const parsed = massSMSSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const { smart_list_id, lead_ids: directLeadIds, message_template, broadcast_name } = parsed.data

  if (!smart_list_id && (!directLeadIds || directLeadIds.length === 0)) {
    return NextResponse.json({ error: 'Provide either smart_list_id or lead_ids' }, { status: 400 })
  }

  // Auth
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id, full_name')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Resolve target leads
  let targetLeadIds: string[] = []

  if (smart_list_id) {
    // Fetch smart list and resolve leads
    const { data: smartList } = await supabase
      .from('smart_lists')
      .select('criteria')
      .eq('id', smart_list_id)
      .eq('organization_id', profile.organization_id)
      .single()

    if (!smartList) {
      return NextResponse.json({ error: 'Smart List not found' }, { status: 404 })
    }

    const { leadIds } = await resolveSmartListLeads(
      supabase,
      profile.organization_id,
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

  // Fetch leads with phone numbers
  const { data: leads } = await supabase
    .from('leads')
    .select('id, phone_formatted, phone, first_name, last_name, email, sms_opt_out')
    .in('id', targetLeadIds.slice(0, 2000))
    .eq('organization_id', profile.organization_id)

  if (!leads || leads.length === 0) {
    return NextResponse.json({ error: 'No leads with phone numbers found' }, { status: 400 })
  }

  // Filter to leads with valid phone & not opted out
  const sendable = leads.filter((l) => {
    const phone = decryptField(l.phone_formatted) || l.phone_formatted
    return phone && !l.sms_opt_out
  })

  if (sendable.length === 0) {
    return NextResponse.json({ error: 'No sendable leads (all opted out or missing phone)' }, { status: 400 })
  }

  // Create a broadcast campaign record for tracking
  const { data: campaign } = await supabase
    .from('campaigns')
    .insert({
      organization_id: profile.organization_id,
      created_by: profile.id,
      name: broadcast_name || `Mass SMS — ${new Date().toLocaleDateString()}`,
      type: 'broadcast',
      channel: 'sms',
      status: 'active',
      smart_list_id: smart_list_id || null,
      total_enrolled: sendable.length,
    })
    .select('id')
    .single()

  // Send SMS to each lead
  const results = {
    total: sendable.length,
    sent: 0,
    failed: 0,
    errors: [] as { lead_id: string; error: string }[],
    campaign_id: campaign?.id || null,
  }

  for (const lead of sendable) {
    try {
      const phone = decryptField(lead.phone_formatted) || lead.phone_formatted

      // Personalize message
      const personalizedMessage = message_template
        .replace(/\{\{first_name\}\}/gi, lead.first_name || '')
        .replace(/\{\{last_name\}\}/gi, lead.last_name || '')
        .replace(/\{\{full_name\}\}/gi, `${lead.first_name || ''} ${lead.last_name || ''}`.trim())

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
            organization_id: profile.organization_id,
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
        continue
      }

      // Send via Twilio
      const twilioResult = await withRetry(
        () => sendSMS(phone, personalizedMessage),
        RETRY_CONFIGS.twilio
      )

      // Store message
      await supabase.from('messages').insert({
        organization_id: profile.organization_id,
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
    } catch (err) {
      results.failed++
      results.errors.push({
        lead_id: lead.id,
        error: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  // Update campaign stats
  if (campaign) {
    await supabase
      .from('campaigns')
      .update({
        total_completed: results.sent,
        status: 'completed',
      })
      .eq('id', campaign.id)
  }

  return NextResponse.json(results)
}
