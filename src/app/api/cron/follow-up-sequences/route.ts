import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { nextDueStep, DEFAULT_FOLLOWUP_SEQUENCE, type Enrollment } from '@/lib/followup/sequence'
import { isSendAllowed } from '@/lib/messaging/test-allowlist'
import { sendEmailToLead } from '@/lib/messaging/resend'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { decryptField } from '@/lib/encryption'

/**
 * GET /api/cron/follow-up-sequences — fire the due step of each active
 * follow-up enrollment. Auth: Bearer CRON_SECRET (fail-closed).
 *
 * SAFETY: default OFF (requires FOLLOWUP_SEQUENCES_ENABLED=true), every send is
 * allowlist- + consent-gated, and a lead that replied after enrolling is stopped.
 */
const STEP_COPY = {
  email: {
    subject: 'Following up on your dental implant consultation',
    body: "Hi {first}, just circling back — we'd love to help you explore dental implants. Want to book a free consultation? Reply anytime and we'll get you scheduled.",
  },
  sms: {
    subject: null as string | null,
    body: "Hi {first}, following up from the dental implant team — want to book your free consult? Reply YES and we'll set it up.",
  },
}

export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Auto-messages leads — must be explicitly enabled.
  if (process.env.FOLLOWUP_SEQUENCES_ENABLED !== 'true') {
    return NextResponse.json({ skipped: 'FOLLOWUP_SEQUENCES_ENABLED not set' })
  }

  const supabase = createServiceClient()
  const nowMs = Date.now()
  const summary = { processed: 0, sent: 0, skipped: 0, stopped: 0, completed: 0 }

  const { data: enrollments } = await supabase
    .from('follow_up_enrollments')
    .select('id, lead_id, organization_id, status, current_step, enrolled_at')
    .eq('status', 'active')
    .limit(500)

  for (const e of enrollments || []) {
    summary.processed++
    const due = nextDueStep(
      { current_step: e.current_step, enrolled_at: e.enrolled_at, status: 'active' } as Enrollment,
      nowMs
    )
    if (!due) { summary.skipped++; continue }

    const { data: lead } = await supabase
      .from('leads')
      .select('id, first_name, email, phone_formatted, last_responded_at')
      .eq('id', e.lead_id)
      .single()
    if (!lead) { summary.skipped++; continue }

    // Stop-on-reply: the lead engaged after enrolling → halt the sequence.
    if (lead.last_responded_at && new Date(lead.last_responded_at).getTime() > new Date(e.enrolled_at).getTime()) {
      await supabase.from('follow_up_enrollments').update({ status: 'stopped', updated_at: new Date().toISOString() }).eq('id', e.id)
      summary.stopped++; continue
    }

    const channel = due.step.channel
    const recipient = (channel === 'email'
      ? decryptField(lead.email) || lead.email
      : decryptField(lead.phone_formatted) || lead.phone_formatted) || ''
    if (!recipient || !isSendAllowed(recipient)) { summary.skipped++; continue }

    const copy = STEP_COPY[channel]
    const body = copy.body.replace('{first}', lead.first_name || 'there')
    if (channel === 'email') {
      const r = await sendEmailToLead({ supabase, leadId: lead.id, to: recipient, subject: copy.subject ?? 'Following up', html: `<p>${body}</p>`, text: body, aiGenerated: true, caller: 'cron.follow-up-sequences' })
      if (r.sent) summary.sent++
    } else {
      const r = await sendSMSToLead({ supabase, leadId: lead.id, to: recipient, body, aiGenerated: true, caller: 'cron.follow-up-sequences' })
      if (r.sent) summary.sent++
    }

    // Advance regardless of send outcome (avoid retry storms); complete on last step.
    const nextStep = e.current_step + 1
    const complete = nextStep >= DEFAULT_FOLLOWUP_SEQUENCE.length
    await supabase
      .from('follow_up_enrollments')
      .update({ current_step: nextStep, status: complete ? 'completed' : 'active', last_step_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', e.id)
    if (complete) summary.completed++
  }

  return NextResponse.json(summary)
}
