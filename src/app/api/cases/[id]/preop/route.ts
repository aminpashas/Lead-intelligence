import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { hasPermission } from '@/lib/auth/permissions'
import { defaultPreopContent, renderPreopHtml } from '@/lib/preop/template'
import { getTreatmentClosingByCase, advanceStepByCase } from '@/lib/treatment/treatment-closing'
import { sendEmail, sendEmailToLead } from '@/lib/messaging/resend'
import { sendSMSToLead } from '@/lib/messaging/twilio'

/**
 * POST /api/cases/[id]/preop — Send pre-op instructions to the patient.
 *
 * Renders the pre-op template into a preop_forms row (share-token portal),
 * delivers the link via SMS and/or email, and advances the closing step.
 * Lead-linked cases go through the consent-gated senders; caseless patients
 * fall back to transactional email only.
 */

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single()
  if (!profile || !hasPermission(profile.role, 'cases:create')) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const { data: caseRow } = await supabase
    .from('clinical_cases')
    .select('id, organization_id, lead_id, patient_name, patient_email, patient_phone')
    .eq('id', caseId)
    .eq('organization_id', orgId)
    .single()
  if (!caseRow) return NextResponse.json({ error: 'Case not found' }, { status: 404 })

  if (!caseRow.patient_email && !caseRow.patient_phone) {
    return NextResponse.json({ error: 'Patient has no email or phone on file' }, { status: 400 })
  }

  const closing = await getTreatmentClosingByCase(supabase, caseId)

  const { data: org } = await supabase
    .from('organizations')
    .select('name, phone')
    .eq('id', orgId)
    .single()

  // Render + persist the form (snapshot of exactly what the patient will see)
  const content = defaultPreopContent({
    patientName: caseRow.patient_name,
    surgeryDate: closing?.surgery_date,
    surgeryTime: closing?.surgery_time,
    surgeryType: closing?.surgery_type,
    practiceName: org?.name,
    practicePhone: org?.phone,
  })
  const renderedHtml = renderPreopHtml({
    patientName: caseRow.patient_name,
    content,
    practiceName: org?.name,
  })

  const { data: form, error: formError } = await supabase
    .from('preop_forms')
    .insert({
      organization_id: orgId,
      clinical_case_id: caseId,
      treatment_closing_id: closing?.id ?? null,
      rendered_html: renderedHtml,
      content,
      status: 'draft',
      created_by: user.id,
    })
    .select()
    .single()
  if (formError || !form) {
    return NextResponse.json({ error: formError?.message ?? 'Could not create pre-op form' }, { status: 500 })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const portalUrl = `${appUrl}/preop/${form.share_token}`

  // ── Delivery ──────────────────────────────────────────────────
  let emailSent = false
  let smsSent = false

  if (caseRow.patient_email) {
    const subject = `Pre-Op Instructions for Your Upcoming Surgery — ${org?.name ?? 'Your Dental Practice'}`
    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:32px 20px;">
        <h2 style="color:#1a1a1a;margin-bottom:8px;">Your Pre-Op Instructions</h2>
        <p style="color:#666;font-size:15px;line-height:1.6;">Dear ${caseRow.patient_name},</p>
        <p style="color:#666;font-size:15px;line-height:1.6;">
          Your surgery is coming up. Please review your pre- and post-operative instructions and
          tap "I've read these" at the bottom so we know you're prepared.
        </p>
        <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:12px;padding:24px;margin:24px 0;text-align:center;">
          <a href="${portalUrl}" style="color:white;font-size:16px;font-weight:600;text-decoration:none;">
            View Pre-Op Instructions →
          </a>
        </div>
        <p style="color:#bbb;font-size:12px;">This is a secure link intended only for you.</p>
      </div>`

    if (caseRow.lead_id) {
      const result = await sendEmailToLead({
        supabase,
        leadId: caseRow.lead_id,
        to: caseRow.patient_email,
        subject,
        html,
        caller: 'preop-instructions',
      })
      emailSent = result.sent
    } else {
      try {
        await sendEmail({ to: caseRow.patient_email, subject, html })
        emailSent = true
      } catch (err) {
        console.error('[preop] transactional email failed', err)
      }
    }
  }

  if (caseRow.patient_phone && caseRow.lead_id) {
    const result = await sendSMSToLead({
      supabase,
      leadId: caseRow.lead_id,
      to: caseRow.patient_phone,
      body: `${org?.name ?? 'Your dental practice'}: your pre-op instructions are ready. Please read and confirm here: ${portalUrl}`,
      caller: 'preop-instructions',
    })
    smsSent = result.sent
  }

  if (!emailSent && !smsSent) {
    // Leave the form as draft so staff can retry; surface why nothing went out
    return NextResponse.json(
      { error: 'Delivery failed on all channels (check consent status and contact info)', form_id: form.id },
      { status: 502 }
    )
  }

  const sentVia = emailSent && smsSent ? 'both' : emailSent ? 'email' : 'sms'
  await supabase
    .from('preop_forms')
    .update({ status: 'sent', sent_via: sentVia, sent_at: new Date().toISOString() })
    .eq('id', form.id)

  // Advance the closing (creates the step timestamp + postop marker)
  await advanceStepByCase(supabase, caseId, 'preop_instructions_sent', {
    preop_sent_via: sentVia as 'sms' | 'email' | 'both',
  })

  return NextResponse.json({ form_id: form.id, sent_via: sentVia, portal_url: portalUrl })
}
