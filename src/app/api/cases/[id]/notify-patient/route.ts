import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/cases/[id]/notify-patient — Send case to patient via email
 */

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Get the case with share token
  const { data: caseData, error: caseError } = await supabase
    .from('clinical_cases')
    .select('*, case_treatment_plans(*), case_diagnosis(*)')
    .eq('id', caseId)
    .single()

  if (caseError || !caseData) {
    return NextResponse.json({ error: 'Case not found' }, { status: 404 })
  }

  if (!caseData.patient_email) {
    return NextResponse.json({ error: 'Patient email is required to send notification' }, { status: 400 })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const caseUrl = `${appUrl}/case/${caseData.share_token}`

  // Send email via Resend
  try {
    const resendKey = process.env.RESEND_API_KEY
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@dionhealth.com'

    if (resendKey) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromEmail,
          to: caseData.patient_email,
          subject: `Your Treatment Plan is Ready — Case ${caseData.case_number}`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 20px;">
              <h2 style="color: #1a1a1a; margin-bottom: 8px;">Your Treatment Plan is Ready</h2>
              <p style="color: #666; font-size: 15px; line-height: 1.6;">
                Dear ${caseData.patient_name},
              </p>
              <p style="color: #666; font-size: 15px; line-height: 1.6;">
                Your doctor has completed the evaluation for <strong>Case ${caseData.case_number}</strong> and prepared a treatment plan for you.
              </p>
              <div style="background: linear-gradient(135deg, #6366f1, #8b5cf6); border-radius: 12px; padding: 24px; margin: 24px 0; text-align: center;">
                <a href="${caseUrl}" style="color: white; font-size: 16px; font-weight: 600; text-decoration: none;">
                  View Your Treatment Plan →
                </a>
              </div>
              <p style="color: #999; font-size: 13px;">
                Click the button above to view your diagnosis, treatment recommendations, and next steps.
                If you have any questions, please don't hesitate to contact our office.
              </p>
              <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
              <p style="color: #bbb; font-size: 12px;">
                This is a secure link intended only for you. Do not share it with others.
              </p>
            </div>
          `,
        }),
      })
    }
  } catch (err) {
    console.error('[NotifyPatient] Email send failed:', err)
  }

  // Update case
  await supabase
    .from('clinical_cases')
    .update({ patient_notified_at: new Date().toISOString() })
    .eq('id', caseId)

  return NextResponse.json({ success: true, case_url: caseUrl })
}
