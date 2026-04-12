import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/messaging/resend'
import { z } from 'zod'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { withRetry, RETRY_CONFIGS } from '@/lib/retry'
import { decryptField } from '@/lib/encryption'
import { resolveSmartListLeads } from '@/lib/campaigns/smart-list-resolver'
import { personalize, PERSONALIZABLE_LEAD_SELECT, type PersonalizableLead } from '@/lib/campaigns/personalization'

const massEmailSchema = z.object({
  smart_list_id: z.string().uuid().optional(),
  lead_ids: z.array(z.string().uuid()).optional(),
  subject_template: z.string().min(1).max(200),
  body_template: z.string().min(1),
  html_body_template: z.string().optional(),
  broadcast_name: z.string().optional(),
})

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()
  const body = await request.json()
  const parsed = massEmailSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const { smart_list_id, lead_ids: directLeadIds, subject_template, body_template, html_body_template, broadcast_name } = parsed.data

  if (!smart_list_id && (!directLeadIds || directLeadIds.length === 0)) {
    return NextResponse.json({ error: 'Provide either smart_list_id or lead_ids' }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id, full_name, email')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let targetLeadIds: string[] = []

  if (smart_list_id) {
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: leadsRaw } = await supabase
    .from('leads')
    .select(PERSONALIZABLE_LEAD_SELECT)
    .in('id', targetLeadIds.slice(0, 2000))
    .eq('organization_id', profile.organization_id)

  const leads = (leadsRaw || []) as unknown as PersonalizableLead[]

  if (leads.length === 0) {
    return NextResponse.json({ error: 'No leads found' }, { status: 400 })
  }

  const sendable = leads.filter((l) => {
    const email = decryptField(l.email) || l.email
    return email && !l.email_opt_out
  })

  if (sendable.length === 0) {
    return NextResponse.json({ error: 'No sendable leads (all opted out or missing email)' }, { status: 400 })
  }

  const { data: campaign } = await supabase
    .from('campaigns')
    .insert({
      organization_id: profile.organization_id,
      created_by: profile.id,
      name: broadcast_name || `Mass Email — ${new Date().toLocaleDateString()}`,
      type: 'broadcast',
      channel: 'email',
      status: 'active',
      smart_list_id: smart_list_id || null,
      total_enrolled: sendable.length,
    })
    .select('id')
    .single()

  const deliveryLog: {
    lead_id: string
    lead_name: string
    email: string
    status: 'sent' | 'failed' | 'skipped'
    error?: string
    sent_at?: string
    subject?: string
  }[] = []

  const results = {
    total: sendable.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    errors: [] as { lead_id: string; error: string }[],
    campaign_id: campaign?.id || null,
    delivery_log: deliveryLog,
  }

  for (const lead of sendable) {
    const email = decryptField(lead.email) || lead.email || ''
    const leadName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'Unknown'

    try {
      const subject = personalize(subject_template, lead)
      const bodyText = personalize(body_template, lead)
      const htmlBody = html_body_template
        ? personalize(html_body_template, lead)
        : `<p>${bodyText.replace(/\n/g, '<br>')}</p>`

      let conversationId: string

      const { data: existingConvo } = await supabase
        .from('conversations')
        .select('id')
        .eq('lead_id', lead.id)
        .eq('channel', 'email')
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
            channel: 'email',
            status: 'active',
            subject,
          })
          .select('id')
          .single()
        conversationId = newConvo?.id || ''
      }

      if (!conversationId) {
        results.failed++
        results.errors.push({ lead_id: lead.id, error: 'Failed to create conversation' })
        deliveryLog.push({ lead_id: lead.id, lead_name: leadName, email, status: 'failed', error: 'Failed to create conversation' })
        continue
      }

      const resendResult = await withRetry(
        () => sendEmail({
          to: email,
          subject,
          html: htmlBody,
          text: bodyText,
          replyTo: profile.email,
        }),
        RETRY_CONFIGS.resend
      )

      await supabase.from('messages').insert({
        organization_id: profile.organization_id,
        conversation_id: conversationId,
        lead_id: lead.id,
        direction: 'outbound',
        channel: 'email',
        body: bodyText,
        html_body: htmlBody,
        subject,
        sender_type: 'user',
        sender_id: profile.id,
        sender_name: profile.full_name,
        email_from: profile.email,
        email_to: email,
        status: 'sent',
        external_id: resendResult.id,
        ai_generated: false,
        metadata: { broadcast: true, campaign_id: campaign?.id },
      })

      results.sent++
      deliveryLog.push({
        lead_id: lead.id,
        lead_name: leadName,
        email,
        status: 'sent',
        sent_at: new Date().toISOString(),
        subject,
      })
    } catch (err) {
      results.failed++
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      results.errors.push({ lead_id: lead.id, error: errorMsg })
      deliveryLog.push({ lead_id: lead.id, lead_name: leadName, email, status: 'failed', error: errorMsg })
    }
  }

  if (campaign) {
    await supabase
      .from('campaigns')
      .update({
        total_completed: results.sent,
        status: 'completed',
        metadata: {
          delivery_log: deliveryLog,
          subject_template,
          body_template,
          broadcast_name,
          smart_list_id,
        },
      })
      .eq('id', campaign.id)
  }

  return NextResponse.json(results)
}
