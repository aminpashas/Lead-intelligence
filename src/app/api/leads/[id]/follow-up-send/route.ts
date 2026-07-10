import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { sendEmailToLead } from '@/lib/messaging/resend'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { isSendAllowed } from '@/lib/messaging/test-allowlist'
import { decryptField } from '@/lib/encryption'

const schema = z.object({
  channel: z.enum(['email', 'sms']),
  subject: z.string().max(200).optional(),
  message: z.string().min(1).max(4000),
})

/**
 * POST /api/leads/[id]/follow-up-send — actually send a follow-up now.
 *
 * Gated three ways: (1) the send allowlist (only TEST_SEND_ALLOWLIST recipients
 * while it's set), (2) the channel's consent gate inside send*ToLead, (3) the
 * compliance filter (aiGenerated). Stores the message in the timeline on success.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: profile } = await getOwnProfile(supabase, 'id, full_name')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = schema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  const { channel, subject, message } = parsed.data

  const { data: lead } = await supabase
    .from('leads')
    .select('id, email, phone_formatted, organization_id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

  const recipient = (channel === 'email'
    ? decryptField(lead.email) || lead.email
    : decryptField(lead.phone_formatted) || lead.phone_formatted) || ''
  if (!recipient) return NextResponse.json({ error: `Lead has no ${channel} address` }, { status: 400 })

  // Safety gate — only allowlisted recipients while the allowlist is active.
  if (!isSendAllowed(recipient)) {
    return NextResponse.json({ error: 'Recipient not on the send allowlist' }, { status: 403 })
  }

  let sent = false
  let reason: string | undefined
  let externalId: string | null = null
  if (channel === 'email') {
    const html = message.split(/\n\n+/).map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`).join('\n')
    const r = await sendEmailToLead({ supabase, leadId: id, to: recipient, subject: subject || 'Following up', html, text: message, aiGenerated: true, caller: 'api.follow-up-send' })
    if (r.sent) { sent = true; externalId = r.id } else { reason = r.reason }
  } else {
    const r = await sendSMSToLead({ supabase, leadId: id, to: recipient, body: message, aiGenerated: true, caller: 'api.follow-up-send', actor: { id: profile.id, label: profile.full_name } })
    if (r.sent) { sent = true; externalId = r.sid } else { reason = r.reason }
  }

  if (!sent) return NextResponse.json({ sent: false, reason })

  // Persist to the timeline (find-or-create the channel conversation) + log activity.
  const { data: convo } = await supabase
    .from('conversations').select('id')
    .eq('lead_id', id).eq('channel', channel).eq('status', 'active').limit(1).maybeSingle()
  let conversationId = convo?.id
  if (!conversationId) {
    const { data: newC } = await supabase
      .from('conversations')
      .insert({ organization_id: orgId, lead_id: id, channel, status: 'active', ai_enabled: true, ai_mode: 'assist' })
      .select('id').single()
    conversationId = newC?.id
  }
  if (conversationId) {
    await supabase.from('messages').insert({
      organization_id: orgId, conversation_id: conversationId, lead_id: id,
      direction: 'outbound', channel, body: message, subject: channel === 'email' ? subject ?? null : null,
      sender_type: 'ai', sender_id: profile.id, sender_name: profile.full_name,
      status: 'sent', external_id: externalId, ai_generated: true,
    })
  }
  await supabase.from('lead_activities').insert({
    organization_id: orgId, lead_id: id, user_id: profile.id,
    activity_type: channel === 'email' ? 'email_sent' : 'sms_sent',
    title: `Follow-up sent (${channel})`, description: message.substring(0, 200),
  })

  return NextResponse.json({ sent: true, external_id: externalId })
}
