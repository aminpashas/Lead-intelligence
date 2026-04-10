/**
 * Financing Follow-Up Automation
 *
 * Automated SMS/email sequences triggered by financing events
 * to ensure patients complete the application and move forward.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { sendSMS } from '@/lib/messaging/twilio'
import { sendEmail } from '@/lib/messaging/resend'
import { decryptField } from '@/lib/encryption'

type FollowUpContext = {
  supabase: SupabaseClient
  leadId: string
  organizationId: string
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
  contact: { firstName: string; phone: string | null; email: string | null },
  smsBody: string,
  emailSubject: string,
  emailHtml: string
): Promise<{ channel: 'sms' | 'email' | null }> {
  // Prefer SMS for urgency, fall back to email
  if (contact.phone) {
    try {
      await sendSMS(contact.phone, smsBody)
      return { channel: 'sms' }
    } catch { /* fall through to email */ }
  }
  if (contact.email) {
    try {
      await sendEmail({ to: contact.email, subject: emailSubject, html: emailHtml })
      return { channel: 'email' }
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
  const url = `${process.env.NEXT_PUBLIC_APP_URL}/finance/${app.share_token}`

  const smsBody = `Hi ${contact.firstName}, just checking in — did you get a chance to look at your financing options? It only takes 2 minutes to apply. Your link expires in ${hoursLeft} hours: ${url}`

  const emailHtml = `
    <h2>Hi ${contact.firstName},</h2>
    <p>We noticed you haven't had a chance to view your personalized financing options yet.</p>
    <p>The application takes just 2 minutes and uses a <strong>soft credit check</strong> that won't affect your score.</p>
    <p><a href="${url}" style="background:#10b981;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;display:inline-block;">View My Options</a></p>
    <p><em>This link expires in ${hoursLeft} hours.</em></p>
  `

  const result = await sendFollowUp(contact, smsBody, 'Your financing options are waiting', emailHtml)

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

  const url = app?.share_token ? `${process.env.NEXT_PUBLIC_APP_URL}/finance/${app.share_token}` : ''

  const smsBody = `Hi ${contact.firstName}, looks like you started your financing application — you're almost done! It only takes 2 more minutes to finish.${url ? ` Continue here: ${url}` : ''} Questions? Just reply.`

  const emailHtml = `
    <h2>You're almost there, ${contact.firstName}!</h2>
    <p>You started your financing application but didn't quite finish. It only takes <strong>2 more minutes</strong> to complete.</p>
    ${url ? `<p><a href="${url}" style="background:#10b981;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;display:inline-block;">Complete My Application</a></p>` : ''}
    <p>Need help? Just reply to this email and we'll walk you through it.</p>
  `

  const result = await sendFollowUp(contact, smsBody, 'You\'re almost done with your application!', emailHtml)

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
  const contact = await getLeadContact(ctx.supabase, ctx.leadId)
  if (!contact) return { sent: false, channel: null, message_type: 'approved' }

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

  const result = await sendFollowUp(contact, smsBody, 'You\'re approved! Let\'s schedule your consultation', emailHtml)

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

  const result = await sendFollowUp(contact, smsBody, 'Let\'s explore your financing options together', emailHtml)

  if (result.channel) {
    await ctx.supabase.from('lead_activities').insert({
      organization_id: ctx.organizationId,
      lead_id: ctx.leadId,
      activity_type: 'financing_denied',
      title: `Financing denial follow-up sent via ${result.channel}`,
      metadata: { type: 'financing_followup', trigger: 'denied', channel: result.channel },
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

  const result = await sendFollowUp(contact, smsBody, 'Your financing application is being reviewed', emailHtml)

  return { sent: !!result.channel, channel: result.channel, message_type: 'pending' }
}

/**
 * Follow-up: Approved but hasn't scheduled consultation (48h).
 * Trigger: 48 hours after approval, no appointment created.
 */
export async function followUpApprovedNoSchedule(ctx: FollowUpContext, approvedAmount: number): Promise<FollowUpResult> {
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

  const smsBody = `Hi ${contact.firstName}, just a friendly reminder — you're approved for $${approvedAmount.toLocaleString()} in financing! 🎉 Ready to schedule your free consultation? Reply with a time that works or call us. We'd love to help you take the next step!`

  const emailHtml = `
    <h2>Ready to take the next step, ${contact.firstName}?</h2>
    <p>Just a reminder — you're <strong>approved for $${approvedAmount.toLocaleString()}</strong> in dental financing!</p>
    <p>The next step is a free consultation where we'll create your personalized treatment plan. It takes about 30 minutes and there's absolutely no obligation.</p>
    <p>Reply to this email with a time that works, or give us a call to schedule.</p>
    <p>We can't wait to help you get started! 😊</p>
  `

  const result = await sendFollowUp(contact, smsBody, 'Your financing is approved — ready to schedule?', emailHtml)

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
