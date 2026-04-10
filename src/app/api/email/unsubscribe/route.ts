import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'

/**
 * GET /api/email/unsubscribe?token=<base64(lead_id:org_id)>
 *
 * CAN-SPAM compliant one-click unsubscribe.
 * Sets email_opt_out = true on the lead and exits active campaign enrollments.
 */
export async function GET(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.publicForm)
  if (rlError) return rlError

  const token = new URL(request.url).searchParams.get('token')
  if (!token) {
    return new NextResponse(renderPage('Missing unsubscribe token.', false), {
      headers: { 'Content-Type': 'text/html' },
    })
  }

  // Decode token
  let leadId: string
  let orgId: string
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8')
    const parts = decoded.split(':')
    if (parts.length !== 2) throw new Error('Invalid format')
    leadId = parts[0]
    orgId = parts[1]

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(leadId) || !uuidRegex.test(orgId)) throw new Error('Invalid IDs')
  } catch {
    return new NextResponse(renderPage('Invalid unsubscribe link.', false), {
      headers: { 'Content-Type': 'text/html' },
    })
  }

  const supabase = createServiceClient()

  // Update lead opt-out
  const { error } = await supabase
    .from('leads')
    .update({
      email_opt_out: true,
      email_opt_out_at: new Date().toISOString(),
    })
    .eq('id', leadId)
    .eq('organization_id', orgId)

  if (error) {
    return new NextResponse(renderPage('Something went wrong. Please try again.', false), {
      headers: { 'Content-Type': 'text/html' },
    })
  }

  // Exit active campaign enrollments
  await supabase
    .from('campaign_enrollments')
    .update({
      status: 'exited',
      completed_at: new Date().toISOString(),
      exit_reason: 'Email unsubscribed',
    })
    .eq('lead_id', leadId)
    .eq('status', 'active')

  return new NextResponse(renderPage('You have been unsubscribed from our emails.', true), {
    headers: { 'Content-Type': 'text/html' },
  })
}

function renderPage(message: string, success: boolean): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribe</title></head>
<body style="font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f9fafb;">
  <div style="text-align: center; max-width: 400px; padding: 40px;">
    <div style="font-size: 48px; margin-bottom: 16px;">${success ? '✓' : '✗'}</div>
    <h1 style="font-size: 24px; margin-bottom: 8px;">${success ? 'Unsubscribed' : 'Error'}</h1>
    <p style="color: #6b7280; font-size: 16px;">${message}</p>
    ${success ? '<p style="color: #9ca3af; font-size: 14px; margin-top: 24px;">You will no longer receive marketing emails from us.</p>' : ''}
  </div>
</body>
</html>`
}
