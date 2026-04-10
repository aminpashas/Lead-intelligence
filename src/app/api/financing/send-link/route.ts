import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendSMS } from '@/lib/messaging/twilio'
import { sendEmail } from '@/lib/messaging/resend'
import { decryptField } from '@/lib/encryption'
import { auditPHITransmission } from '@/lib/hipaa-audit'
import { buildFinancingBreakdown } from '@/lib/financing/calculator'
import { z } from 'zod'
import crypto from 'crypto'

const sendLinkSchema = z.object({
  lead_id: z.string().uuid(),
  channel: z.enum(['sms', 'email', 'both']),
  treatment_value: z.number().positive().optional(),
  custom_message: z.string().max(500).optional(),
})

/**
 * POST /api/financing/send-link
 * Creates a financing application, generates a share token,
 * builds a breakdown, and sends the link to the patient via SMS/email.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const body = await request.json()
  const parsed = sendLinkSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const { lead_id, channel, treatment_value, custom_message } = parsed.data

  // Fetch lead
  const { data: lead, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', lead_id)
    .single()

  if (error || !lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  // Decrypt contact info
  const email = lead.email ? decryptField(lead.email) : null
  const phone = lead.phone_formatted
    ? decryptField(lead.phone_formatted)
    : lead.phone ? decryptField(lead.phone) : null

  if (channel === 'sms' && !phone) {
    return NextResponse.json({ error: 'Lead has no phone number for SMS' }, { status: 400 })
  }
  if (channel === 'email' && !email) {
    return NextResponse.json({ error: 'Lead has no email address' }, { status: 400 })
  }

  // Update treatment value if provided
  const effectiveTreatmentValue = treatment_value || lead.treatment_value
  if (!effectiveTreatmentValue) {
    return NextResponse.json({ error: 'Treatment value is required. Set it on the lead or pass treatment_value.' }, { status: 400 })
  }

  if (treatment_value) {
    await supabase.from('leads').update({ treatment_value }).eq('id', lead_id)
  }

  // Check for existing active application or create new one
  let applicationId: string
  let shareToken: string

  const { data: existingApp } = await supabase
    .from('financing_applications')
    .select('id, share_token')
    .eq('lead_id', lead_id)
    .in('status', ['pending', 'in_progress'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (existingApp?.share_token) {
    applicationId = existingApp.id
    shareToken = existingApp.share_token
  } else {
    // Create new application with share token
    shareToken = crypto.randomBytes(32).toString('hex')
    const { data: newApp, error: appError } = await supabase
      .from('financing_applications')
      .insert({
        organization_id: lead.organization_id,
        lead_id: lead_id,
        status: 'pending',
        requested_amount: effectiveTreatmentValue,
        share_token: shareToken,
        consent_given_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(), // 72h
        waterfall_config: { lenders: [] },
        applicant_data_encrypted: '',
      })
      .select('id')
      .single()

    if (appError || !newApp) {
      return NextResponse.json({ error: 'Failed to create financing application' }, { status: 500 })
    }
    applicationId = newApp.id

    // Update lead with financing reference
    await supabase.from('leads').update({
      financing_application_id: applicationId,
      status: lead.status === 'new' || lead.status === 'contacted' ? 'treatment_presented' : lead.status,
    }).eq('id', lead_id)
  }

  // Build quick breakdown for the message
  const breakdown = buildFinancingBreakdown({
    treatment_value: effectiveTreatmentValue,
    has_dental_insurance: lead.has_dental_insurance,
    budget_range: lead.budget_range,
  })

  const lowestMonthly = breakdown.recommendation.lowest_monthly
  const zeroInterest = breakdown.recommendation.zero_interest
  const appUrl = `${process.env.NEXT_PUBLIC_APP_URL}/finance/${shareToken}`

  // Build messages
  const firstName = lead.first_name || 'there'
  const smsBody = custom_message || [
    `Hi ${firstName}! We've put together your personalized financing options for your dental treatment.`,
    lowestMonthly ? `Payments as low as $${Math.round(lowestMonthly.monthly_payment)}/mo.` : '',
    zeroInterest ? `0% interest options available!` : '',
    `View your options & apply here: ${appUrl}`,
    `Questions? Just reply to this text.`,
  ].filter(Boolean).join(' ')

  const emailSubject = `Your Personalized Dental Financing Options`
  const emailBody = `
    <h2>Hi ${firstName},</h2>
    <p>We've prepared a personalized financing breakdown for your dental treatment.</p>
    <p><strong>Treatment Value:</strong> $${effectiveTreatmentValue.toLocaleString()}</p>
    ${lowestMonthly ? `<p><strong>Monthly payments as low as:</strong> $${Math.round(lowestMonthly.monthly_payment)}/mo</p>` : ''}
    ${zeroInterest ? `<p>🎉 <strong>0% interest options available!</strong></p>` : ''}
    <p>We've partnered with multiple lenders to give you the best rates. View all your options and apply in just 2 minutes:</p>
    <p><a href="${appUrl}" style="background:#10b981;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;display:inline-block;font-weight:bold;">View My Financing Options</a></p>
    <p>The application uses a soft credit check that won't affect your credit score.</p>
    <p>Questions? Reply to this email or call us anytime.</p>
  `

  const sentVia: string[] = []

  // Send SMS
  if ((channel === 'sms' || channel === 'both') && phone) {
    try {
      await auditPHITransmission(
        { supabase, organizationId: lead.organization_id, actorType: 'user' },
        'lead', lead_id, 'twilio_sms', ['phone']
      )
      await sendSMS(phone, smsBody)
      sentVia.push('sms')
    } catch {
      if (channel === 'sms') {
        return NextResponse.json({ error: 'Failed to send SMS' }, { status: 500 })
      }
    }
  }

  // Send Email
  if ((channel === 'email' || channel === 'both') && email) {
    try {
      await auditPHITransmission(
        { supabase, organizationId: lead.organization_id, actorType: 'user' },
        'lead', lead_id, 'resend_email', ['email']
      )
      await sendEmail({
        to: email,
        subject: emailSubject,
        html: emailBody,
      })
      sentVia.push('email')
    } catch {
      if (channel === 'email') {
        return NextResponse.json({ error: 'Failed to send email' }, { status: 500 })
      }
    }
  }

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: lead.organization_id,
    lead_id: lead_id,
    activity_type: 'financing_applied',
    title: `Financing link sent via ${sentVia.join(' & ')}`,
    description: `Patient link: ${appUrl} | Treatment: $${effectiveTreatmentValue.toLocaleString()} | Lowest monthly: $${lowestMonthly ? Math.round(lowestMonthly.monthly_payment) : 'N/A'}/mo`,
    metadata: {
      application_id: applicationId,
      share_token: shareToken,
      channel,
      sent_via: sentVia,
      treatment_value: effectiveTreatmentValue,
    },
  })

  return NextResponse.json({
    success: true,
    application_id: applicationId,
    share_token: shareToken,
    financing_url: appUrl,
    sent_via: sentVia,
    message_preview: channel === 'email' ? emailSubject : smsBody.substring(0, 160),
    breakdown_summary: {
      amount_to_finance: breakdown.amount_to_finance,
      lowest_monthly: lowestMonthly?.monthly_payment || null,
      zero_interest_available: !!zeroInterest,
      total_options: breakdown.scenarios.length,
      total_lenders: breakdown.lender_options.length,
    },
  })
}
