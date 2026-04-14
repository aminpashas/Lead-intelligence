import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { confirmAppointment } from '@/lib/campaigns/reminders'

/**
 * GET /api/appointments/confirm?token=xxx&action=confirm|reschedule
 *
 * Handles email one-click confirmation and reschedule requests.
 * The token encodes appointment_id and org_id.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const token = searchParams.get('token')
  const action = searchParams.get('action') || 'confirm'

  if (!token) {
    return renderHtml('Invalid Link', 'The confirmation link is invalid or has expired.', 'error')
  }

  // Decode the token
  let appointmentId: string
  let orgId: string
  try {
    const decoded = Buffer.from(token, 'base64url').toString()
    const parts = decoded.split(':')
    if (parts.length < 3 || parts[0] !== 'apt') {
      throw new Error('Invalid token format')
    }
    appointmentId = parts[1]
    orgId = parts[2]
  } catch {
    return renderHtml('Invalid Link', 'The confirmation link is invalid or has expired.', 'error')
  }

  const supabase = await createClient()

  if (action === 'confirm') {
    const result = await confirmAppointment(supabase, appointmentId, 'email_click', orgId)

    if (result.success) {
      return renderHtml(
        'Appointment Confirmed! ✅',
        'Thank you for confirming your appointment. We look forward to seeing you! You can close this page now.',
        'success'
      )
    } else {
      return renderHtml(
        'Something Went Wrong',
        result.error || 'We couldn\'t confirm your appointment. Please call our office directly.',
        'error'
      )
    }
  } else if (action === 'reschedule') {
    // Flag the appointment for reschedule
    await supabase
      .from('appointments')
      .update({
        reschedule_requested: true,
        no_show_risk_score: 25,
      })
      .eq('id', appointmentId)
      .eq('organization_id', orgId)

    // Get lead for activity logging
    const { data: apt } = await supabase
      .from('appointments')
      .select('lead_id')
      .eq('id', appointmentId)
      .single()

    if (apt) {
      await supabase.from('lead_activities').insert({
        organization_id: orgId,
        lead_id: apt.lead_id,
        activity_type: 'appointment_reschedule_requested',
        title: 'Reschedule requested via email link',
        metadata: { appointment_id: appointmentId },
      })
    }

    return renderHtml(
      'Reschedule Request Received 📅',
      'We\'ve received your request to reschedule. Our team will contact you shortly to find a new time that works for you. You can close this page now.',
      'info'
    )
  }

  return renderHtml('Invalid Action', 'The requested action is not recognized.', 'error')
}

/**
 * POST /api/appointments/confirm
 *
 * Manual confirmation from the dashboard or SMS webhook.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const body = await request.json()

  const { appointment_id, method } = body

  if (!appointment_id) {
    return NextResponse.json({ error: 'appointment_id is required' }, { status: 400 })
  }

  // Get user profile for org scoping
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await confirmAppointment(
    supabase,
    appointment_id,
    method || 'manual',
    profile.organization_id
  )

  if (result.success) {
    return NextResponse.json({ success: true })
  } else {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }
}

// ═══════════════════════════════════════════════════════════════
// HTML RENDERER (for email confirmation landing pages)
// ═══════════════════════════════════════════════════════════════

function renderHtml(title: string, message: string, type: 'success' | 'error' | 'info'): NextResponse {
  const colors = {
    success: { bg: '#ecfdf5', border: '#10b981', icon: '✅', text: '#065f46' },
    error: { bg: '#fef2f2', border: '#ef4444', icon: '❌', text: '#991b1b' },
    info: { bg: '#eff6ff', border: '#3b82f6', icon: '📅', text: '#1e40af' },
  }

  const c = colors[type]

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0;
      padding: 20px;
    }
    .card {
      background: #fff;
      border-radius: 16px;
      padding: 48px 40px;
      max-width: 480px;
      width: 100%;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.08);
      border: 1px solid #e5e7eb;
    }
    .icon {
      font-size: 48px;
      margin-bottom: 20px;
      display: block;
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      color: ${c.text};
      margin: 0 0 16px 0;
    }
    p {
      font-size: 16px;
      color: #6b7280;
      line-height: 1.6;
      margin: 0;
    }
    .badge {
      display: inline-block;
      background: ${c.bg};
      border: 1px solid ${c.border}33;
      color: ${c.text};
      font-size: 13px;
      font-weight: 600;
      padding: 6px 16px;
      border-radius: 20px;
      margin-top: 24px;
    }
  </style>
</head>
<body>
  <div class="card">
    <span class="icon">${c.icon}</span>
    <h1>${title}</h1>
    <p>${message}</p>
    <span class="badge">${type === 'success' ? 'Confirmed' : type === 'error' ? 'Error' : 'Request Noted'}</span>
  </div>
</body>
</html>`

  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
