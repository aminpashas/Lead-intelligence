/**
 * Financing Follow-Up Automation
 *
 * Automated SMS/email sequences triggered by financing events
 * to ensure patients complete the application and move forward.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { sendEmailToLead } from '@/lib/messaging/resend'
import { decryptField } from '@/lib/encryption'
import { getPublicAppUrl } from '@/lib/app-url'

type FollowUpContext = {
  supabase: SupabaseClient
  leadId: string
  organizationId: string
}

/**
 * KILL SWITCH for automated "you've been approved" patient notifications.
 *
 * A false credit-approval text (asserting an approval the patient never applied
 * for) is FCRA / UDAAP / TCPA exposure. Because a sandbox/UAT lender credential
 * or seeded data can write a genuine `financing_submissions.status='approved'`
 * row, the per-message "real approved submission" guard is NOT enough on its
 * own. This master switch is OFF unless `FINANCING_APPROVAL_SMS_ENABLED=true`
 * is explicitly set, so the default posture is: never auto-assert an approval.
 * When off, callers log + escalate for human review instead of texting.
 */
function approvalNoticesEnabled(): boolean {
  return process.env.FINANCING_APPROVAL_SMS_ENABLED === 'true'
}

/** Record that an approval notice was withheld so a human can verify + follow up. */
async function escalateWithheldApproval(
  ctx: FollowUpContext,
  trigger: string,
  approvedAmount: number
): Promise<void> {
  console.warn(
    `[financing.follow-up] Approval notice WITHHELD (kill switch) for lead ${ctx.leadId} ` +
      `(trigger=${trigger}, amount=${approvedAmount}). Set FINANCING_APPROVAL_SMS_ENABLED=true to enable.`
  )
  await ctx.supabase.from('lead_activities').insert({
    organization_id: ctx.organizationId,
    lead_id: ctx.leadId,
    activity_type: 'financing_approval_withheld',
    title: 'Automated approval SMS withheld — needs human verification',
    metadata: { type: 'financing_followup', trigger, approved_amount: approvedAmount, reason: 'approval_sms_kill_switch' },
  }).then(() => {}, () => { /* activity logging is best-effort */ })
}

type FollowUpResult = {
  sent: boolean
  channel: 'sms' | 'email' | null
  message_type: string
}

async function getLeadContact(supabase: SupabaseClient, leadId: string) {
  const { data: lead } = await supabase
    .from('leads')
    .select('first_name, phone, phone_formatted, email, organization_id')
    .eq('id', leadId)
    .single()

  if (!lead) return null

  return {
    firstName: lead.first_name || 'there',
    phone: lead.phone_formatted ? decryptField(lead.phone_formatted) : lead.phone ? decryptField(lead.phone) : null,
    email: lead.email ? decryptField(lead.email) : null,
    organizationId: lead.organization_id,
  }
}

async function sendFollowUp(
  ctx: FollowUpContext,
  contact: { firstName: string; phone: string | null; email: string | null },
  smsBody: string,
  emailSubject: string,
  emailHtml: string
): Promise<{ channel: 'sms' | 'email' | null }> {
  // Prefer SMS for urgency, fall back to email.
  // SMS goes through the TCPA consent gate — if the lead hasn't consented or opted
  // out, sendSMSToLead returns { sent: false } and we fall through to email.
  if (contact.phone) {
    try {
      const res = await sendSMSToLead({
        supabase: ctx.supabase,
        leadId: ctx.leadId,
        to: contact.phone,
        body: smsBody,
        caller: 'financing.follow-up',
      })
      if (res.sent) return { channel: 'sms' }
      /* consent denied — fall through to email */
    } catch { /* fall through to email */ }
  }
  if (contact.email) {
    try {
      // CAN-SPAM consent gate — symmetric with the SMS branch above. If the lead
      // hasn't granted email consent (or unsubscribed), sendEmailToLead refuses.
      const res = await sendEmailToLead({
        supabase: ctx.supabase,
        leadId: ctx.leadId,
        to: contact.email,
        subject: emailSubject,
        html: emailHtml,
        caller: 'financing.follow-up',
      })
      if (res.sent) return { channel: 'email' }
      /* consent denied */
    } catch { /* both failed */ }
  }
  return { channel: null }
}

/**
 * Follow-up: Financing link sent but patient hasn't started the application.
 * Trigger: 24 hours after link sent, no form_started event.
 */
export async function followUpLinkNotStarted(ctx: FollowUpContext): Promise<FollowUpResult> {
  const contact = await getLeadContact(ctx.supabase, ctx.leadId)
  if (!contact) return { sent: false, channel: null, message_type: 'link_not_started' }

  // Check if there's an active application with a share token
  const { data: app } = await ctx.supabase
    .from('financing_applications')
    .select('share_token, expires_at')
    .eq('lead_id', ctx.leadId)
    .in('status', ['pending'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (!app?.share_token) return { sent: false, channel: null, message_type: 'link_not_started' }

  const expiresAt = new Date(app.expires_at)
  const hoursLeft = Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60)))
  const url = `${getPublicAppUrl()}/finance/${app.share_token}`

  const smsBody = `Hi ${contact.firstName}, just checking in — did you get a chance to look at your financing options? It only takes 2 minutes to apply. Your link expires in ${hoursLeft} hours: ${url}`

  const emailHtml = `
    <h2>Hi ${contact.firstName},</h2>
    <p>We noticed you haven't had a chance to view your personalized financing options yet.</p>
    <p>The application takes just 2 minutes and uses a <strong>soft credit check</strong> that won't affect your score.</p>
    <p><a href="${url}" style="background:#10b981;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;display:inline-block;">View My Options</a></p>
    <p><em>This link expires in ${hoursLeft} hours.</em></p>
  `

  const result = await sendFollowUp(ctx, contact, smsBody, 'Your financing options are waiting', emailHtml)

  if (result.channel) {
    await ctx.supabase.from('lead_activities').insert({
      organization_id: ctx.organizationId,
      lead_id: ctx.leadId,
      activity_type: 'sms_sent',
      title: 'Financing follow-up: link not started (24h)',
      metadata: { type: 'financing_followup', trigger: 'link_not_started', channel: result.channel },
    })
  }

  return { sent: !!result.channel, channel: result.channel, message_type: 'link_not_started' }
}

/**
 * Follow-up: Patient started the form but didn't complete it.
 * Trigger: 2 hours after form opened, no submission.
 */
export async function followUpFormAbandoned(ctx: FollowUpContext): Promise<FollowUpResult> {
  const contact = await getLeadContact(ctx.supabase, ctx.leadId)
  if (!contact) return { sent: false, channel: null, message_type: 'form_abandoned' }

  const { data: app } = await ctx.supabase
    .from('financing_applications')
    .select('share_token')
    .eq('lead_id', ctx.leadId)
    .in('status', ['pending', 'in_progress'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  const url = app?.share_token ? `${getPublicAppUrl()}/finance/${app.share_token}` : ''

  const smsBody = `Hi ${contact.firstName}, looks like you started your financing application — you're almost done! It only takes 2 more minutes to finish.${url ? ` Continue here: ${url}` : ''} Questions? Just reply.`

  const emailHtml = `
    <h2>You're almost there, ${contact.firstName}!</h2>
    <p>You started your financing application but didn't quite finish. It only takes <strong>2 more minutes</strong> to complete.</p>
    ${url ? `<p><a href="${url}" style="background:#10b981;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;display:inline-block;">Complete My Application</a></p>` : ''}
    <p>Need help? Just reply to this email and we'll walk you through it.</p>
  `

  const result = await sendFollowUp(ctx, contact, smsBody, 'You\'re almost done with your application!', emailHtml)

  if (result.channel) {
    await ctx.supabase.from('lead_activities').insert({
      organization_id: ctx.organizationId,
      lead_id: ctx.leadId,
      activity_type: 'sms_sent',
      title: 'Financing follow-up: form abandoned (2h)',
      metadata: { type: 'financing_followup', trigger: 'form_abandoned', channel: result.channel },
    })
  }

  return { sent: !!result.channel, channel: result.channel, message_type: 'form_abandoned' }
}

/**
 * Follow-up: Patient was APPROVED — schedule consultation.
 * Trigger: Immediately after waterfall returns approved.
 */
export async function followUpApproved(
  ctx: FollowUpContext,
  approvedAmount: number,
  monthlyPayment: number,
  lenderName: string
): Promise<FollowUpResult> {
  // KILL SWITCH: default-off. Never auto-assert a credit approval unless the
  // practice has explicitly enabled it after verifying no test/sandbox lender is
  // firing real patient SMS. See approvalNoticesEnabled().
  if (!approvalNoticesEnabled()) {
    await escalateWithheldApproval(ctx, 'approved', approvedAmount)
    return { sent: false, channel: null, message_type: 'approved' }
  }

  const contact = await getLeadContact(ctx.supabase, ctx.leadId)
  if (!contact) return { sent: false, channel: null, message_type: 'approved' }

  // GUARD: never assert a credit approval to a patient without a genuine lender
  // decision on record. This message states a definitive outcome ("you've been
  // approved for $X through Y") — sending it without a real approval is a false
  // credit-approval claim (FCRA / UDAAP / TCPA exposure). The only legitimate
  // caller (executeWaterfall) writes financing_submissions.status='approved'
  // before invoking this, so a matching row must exist. A direct or fabricated
  // call — a test harness, or a link-only lender like Cherry that has no API
  // decision — has no such row and is refused here.
  const { data: approvedSubmission } = await ctx.supabase
    .from('financing_submissions')
    .select('id')
    .eq('lead_id', ctx.leadId)
    .eq('status', 'approved')
    .limit(1)
    .maybeSingle()

  if (!approvedSubmission) {
    console.warn(
      `[financing.follow-up] Refusing approval notice for lead ${ctx.leadId}: ` +
        `no financing_submissions row with status='approved' (lender=${lenderName}, amount=${approvedAmount}).`
    )
    return { sent: false, channel: null, message_type: 'approved' }
  }

  const smsBody = `Great news, ${contact.firstName}! 🎉 You've been approved for $${approvedAmount.toLocaleString()} in dental financing through ${lenderName} — that's just $${Math.round(monthlyPayment)}/mo. Let's get your consultation scheduled! Reply with a good time or call us.`

  const emailHtml = `
    <h2>Great news, ${contact.firstName}! 🎉</h2>
    <p>You've been <strong>approved</strong> for dental financing:</p>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin:16px 0;">
      <p style="margin:4px 0;"><strong>Approved Amount:</strong> $${approvedAmount.toLocaleString()}</p>
      <p style="margin:4px 0;"><strong>Monthly Payment:</strong> $${Math.round(monthlyPayment)}/mo</p>
      <p style="margin:4px 0;"><strong>Lender:</strong> ${lenderName}</p>
    </div>
    <p>The next step is scheduling your consultation. Reply to this email or call us to find a time that works for you.</p>
    <p>We're excited to help you get started on your new smile!</p>
  `

  const result = await sendFollowUp(ctx, contact, smsBody, 'You\'re approved! Let\'s schedule your consultation', emailHtml)

  if (result.channel) {
    await ctx.supabase.from('lead_activities').insert({
      organization_id: ctx.organizationId,
      lead_id: ctx.leadId,
      activity_type: 'financing_approved',
      title: `Financing approval notification sent via ${result.channel}`,
      metadata: { type: 'financing_followup', trigger: 'approved', approved_amount: approvedAmount, lender: lenderName },
    })
  }

  return { sent: !!result.channel, channel: result.channel, message_type: 'approved' }
}

/**
 * Follow-up: Patient was DENIED by all lenders — offer alternatives.
 * Trigger: After waterfall exhausted all lenders.
 */
export async function followUpDenied(ctx: FollowUpContext): Promise<FollowUpResult> {
  const contact = await getLeadContact(ctx.supabase, ctx.leadId)
  if (!contact) return { sent: false, channel: null, message_type: 'denied' }

  const smsBody = `Hi ${contact.firstName}, we wanted to reach out about your financing application. We have several other options to make your treatment affordable — including in-house payment plans. Can we chat about what works best for you? Reply YES or call us.`

  const emailHtml = `
    <h2>Hi ${contact.firstName},</h2>
    <p>Thank you for your interest in dental financing. While the initial application didn't get the result we were hoping for, <strong>we have other options</strong> available:</p>
    <ul>
      <li>In-house payment plans with flexible terms</li>
      <li>Adjusted treatment plans that may reduce the financed amount</li>
      <li>Alternative lender programs for different credit profiles</li>
    </ul>
    <p>We help patients at every budget level. Reply to this email or give us a call — we'd love to find something that works for you.</p>
  `

  const result = await sendFollowUp(ctx, contact, smsBody, 'Let\'s explore your financing options together', emailHtml)

  if (result.channel) {
    await ctx.supabase.from('lead_activities').insert({
      organization_id: ctx.organizationId,
      lead_id: ctx.leadId,
      activity_type: 'financing_denied',
      title: `Financing denial follow-up sent via ${result.channel}`,
      metadata: { type: 'financing_followup', trigger: 'denied', channel: result.channel },
    })
  }

  // This SMS ends "Reply YES or call us" — claim the lead's next YES for the
  // financing conversation so the appointment-confirmation handler can't grab it.
  if (result.channel === 'sms') {
    const { setPendingReplyIntent } = await import('@/lib/messaging/pending-intent')
    await setPendingReplyIntent(ctx.supabase, {
      organizationId: ctx.organizationId,
      leadId: ctx.leadId,
      intent: 'financing_followup',
      refType: 'financing_application',
    })
  }

  return { sent: !!result.channel, channel: result.channel, message_type: 'denied' }
}

/**
 * Follow-up: Application PENDING — status update to patient.
 * Trigger: When a lender returns pending (async review).
 */
export async function followUpPending(ctx: FollowUpContext, lenderName: string): Promise<FollowUpResult> {
  const contact = await getLeadContact(ctx.supabase, ctx.leadId)
  if (!contact) return { sent: false, channel: null, message_type: 'pending' }

  const smsBody = `Hi ${contact.firstName}, your financing application with ${lenderName} is being reviewed. We'll let you know as soon as we have a decision — usually within 24 hours. No action needed from you right now!`

  const emailHtml = `
    <h2>Your application is being reviewed, ${contact.firstName}</h2>
    <p>Your financing application with <strong>${lenderName}</strong> is currently under review. Most decisions come back within 24 hours.</p>
    <p>No action is needed from you right now — we'll reach out as soon as we hear back.</p>
    <p>If you have any questions in the meantime, just reply to this email.</p>
  `

  const result = await sendFollowUp(ctx, contact, smsBody, 'Your financing application is being reviewed', emailHtml)

  return { sent: !!result.channel, channel: result.channel, message_type: 'pending' }
}

/**
 * Follow-up: Approved but hasn't scheduled consultation (48h).
 * Trigger: 48 hours after approval, no appointment created.
 */
export async function followUpApprovedNoSchedule(ctx: FollowUpContext, approvedAmount: number): Promise<FollowUpResult> {
  // KILL SWITCH: default-off (see approvalNoticesEnabled()).
  if (!approvalNoticesEnabled()) {
    await escalateWithheldApproval(ctx, 'approved_no_schedule', approvedAmount)
    return { sent: false, channel: null, message_type: 'approved_no_schedule' }
  }

  const contact = await getLeadContact(ctx.supabase, ctx.leadId)
  if (!contact) return { sent: false, channel: null, message_type: 'approved_no_schedule' }

  // Check if appointment already exists
  const { data: appointments } = await ctx.supabase
    .from('appointments')
    .select('id')
    .eq('lead_id', ctx.leadId)
    .in('status', ['scheduled', 'confirmed'])
    .limit(1)

  if (appointments && appointments.length > 0) {
    return { sent: false, channel: null, message_type: 'approved_no_schedule' }
  }

  // GUARD (mirror of followUpApproved): never assert a credit approval without a
  // genuine lender decision on record. "you're approved for $X" is a definitive
  // credit-outcome claim — sending it off a bare amount is a false approval
  // claim (FCRA / UDAAP / TCPA exposure). Require a real approved submission.
  const { data: approvedSubmission } = await ctx.supabase
    .from('financing_submissions')
    .select('id')
    .eq('lead_id', ctx.leadId)
    .eq('status', 'approved')
    .limit(1)
    .maybeSingle()

  if (!approvedSubmission) {
    console.warn(
      `[financing.follow-up] Refusing approved-no-schedule notice for lead ${ctx.leadId}: ` +
        `no financing_submissions row with status='approved' (amount=${approvedAmount}).`
    )
    return { sent: false, channel: null, message_type: 'approved_no_schedule' }
  }

  const smsBody = `Hi ${contact.firstName}, just a friendly reminder — you're approved for $${approvedAmount.toLocaleString()} in financing! 🎉 Ready to schedule your free consultation? Reply with a time that works or call us. We'd love to help you take the next step!`

  const emailHtml = `
    <h2>Ready to take the next step, ${contact.firstName}?</h2>
    <p>Just a reminder — you're <strong>approved for $${approvedAmount.toLocaleString()}</strong> in dental financing!</p>
    <p>The next step is a free consultation where we'll create your personalized treatment plan. It takes about 30 minutes and there's absolutely no obligation.</p>
    <p>Reply to this email with a time that works, or give us a call to schedule.</p>
    <p>We can't wait to help you get started! 😊</p>
  `

  const result = await sendFollowUp(ctx, contact, smsBody, 'Your financing is approved — ready to schedule?', emailHtml)

  if (result.channel) {
    await ctx.supabase.from('lead_activities').insert({
      organization_id: ctx.organizationId,
      lead_id: ctx.leadId,
      activity_type: 'sms_sent',
      title: 'Financing follow-up: approved, no consultation scheduled (48h)',
      metadata: { type: 'financing_followup', trigger: 'approved_no_schedule', channel: result.channel },
    })
  }

  return { sent: !!result.channel, channel: result.channel, message_type: 'approved_no_schedule' }
}
