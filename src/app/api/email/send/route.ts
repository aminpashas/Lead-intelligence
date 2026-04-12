import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/messaging/resend'
import { z } from 'zod'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { withRetry, RETRY_CONFIGS } from '@/lib/retry'
import { decryptField } from '@/lib/encryption'
import { auditPHITransmission } from '@/lib/hipaa-audit'

const sendEmailSchema = z.object({
  lead_id: z.string().uuid(),
  subject: z.string().min(1),
  body: z.string().min(1),
  html_body: z.string().optional(),
  ai_generated: z.boolean().optional().default(false),
})

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()
  const body = await request.json()
  const parsed = sendEmailSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id, full_name, email')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: lead } = await supabase
    .from('leads')
    .select('id, email, first_name, last_name, organization_id')
    .eq('id', parsed.data.lead_id)
    .eq('organization_id', profile.organization_id) // Defense-in-depth: explicit org scoping
    .single()

  if (!lead || !lead.email) {
    return NextResponse.json({ error: 'Lead not found or has no email' }, { status: 404 })
  }

  // Decrypt PII fields
  lead.email = decryptField(lead.email) || lead.email

  // Find or create email conversation
  let conversation
  const { data: existingConvo } = await supabase
    .from('conversations')
    .select('id')
    .eq('lead_id', lead.id)
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
        organization_id: profile.organization_id,
        lead_id: lead.id,
        channel: 'email',
        status: 'active',
        subject: parsed.data.subject,
      })
      .select('id')
      .single()
    conversation = newConvo
  }

  if (!conversation) {
    return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 })
  }

  try {
    // HIPAA audit: PHI transmitted to Resend
    auditPHITransmission(
      { supabase, organizationId: lead.organization_id, actorId: profile.id },
      'lead',
      lead.id,
      'Resend Email',
      ['email'],
    )

    const htmlBody = parsed.data.html_body || `<p>${parsed.data.body.replace(/\n/g, '<br>')}</p>`

    const result = await withRetry(
      () => sendEmail({
        to: lead.email,
        subject: parsed.data.subject,
        html: htmlBody,
        text: parsed.data.body,
        replyTo: profile.email,
      }),
      RETRY_CONFIGS.resend
    )

    const { data: message } = await supabase
      .from('messages')
      .insert({
        organization_id: profile.organization_id,
        conversation_id: conversation.id,
        lead_id: lead.id,
        direction: 'outbound',
        channel: 'email',
        body: parsed.data.body,
        html_body: htmlBody,
        subject: parsed.data.subject,
        sender_type: parsed.data.ai_generated ? 'ai' : 'user',
        sender_id: profile.id,
        sender_name: profile.full_name,
        email_from: profile.email,
        email_to: lead.email,
        status: 'sent',
        external_id: result.id,
        ai_generated: parsed.data.ai_generated,
      })
      .select()
      .single()

    await supabase.from('lead_activities').insert({
      organization_id: profile.organization_id,
      lead_id: lead.id,
      user_id: profile.id,
      activity_type: 'email_sent',
      title: `Email sent: ${parsed.data.subject}`,
      description: parsed.data.body.substring(0, 200),
    })

    return NextResponse.json({ message, resend_id: result.id })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to send email'
    return NextResponse.json({ error: errorMsg }, { status: 500 })
  }
}
