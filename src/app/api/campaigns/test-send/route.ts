import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, requirePermission } from '@/lib/auth/active-org'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { decryptField } from '@/lib/encryption'
import { previewPersonalize } from '@/lib/campaigns/personalization'
import { sendSMS } from '@/lib/messaging/twilio'
import { sendEmail, transactionalFrom } from '@/lib/messaging/resend'
import { getOrgFlags } from '@/lib/org/flags'
import { isUsSmsBlocked, A2P_PENDING_MESSAGE } from '@/lib/messaging/a2p-gate'

/**
 * Send a single campaign step to the LOGGED-IN STAFFER — and ONLY to them — as a
 * real SMS/email, so an admin can preview what a step looks like on a live device
 * before blasting patients.
 *
 * SAFETY (this touches live messaging):
 *  - The recipient is NEVER taken from the request body. It is resolved
 *    server-side from the authenticated user's own `user_profiles` row (their
 *    phone for SMS, their account email for email). The body carries only the
 *    step's channel + content, so the endpoint cannot be weaponized to reach a
 *    patient or any arbitrary address.
 *  - Gated by `campaigns:write` (the same permission the builder needs to save a
 *    campaign) via requirePermission, which also resolves the effective org.
 *  - Personalization vars ({{first_name}} …) are replaced with obvious sample
 *    values (previewPersonalize → "John", etc.) so the message reads as a preview.
 *  - Reuses the low-level `sendSMS` / `sendEmail` helpers — the same choke points
 *    the mass composers funnel through — so DRY-RUN / TEST_SEND_ALLOWLIST clamps,
 *    the Messaging Service / from-number logic, and transactional-domain routing
 *    are all identical. No new raw Twilio/Resend client is created here.
 *  - SMS additionally honors the org's A2P 10DLC gate (isUsSmsBlocked), matching
 *    the mass-SMS route.
 */

const testSendSchema = z.object({
  channel: z.enum(['sms', 'email']),
  subject: z.string().max(200).optional(),
  body: z.string().min(1).max(5000),
})

// Same normalization the ring-my-phone bridge uses on a staff profile number.
function normalizePhone(raw: string): string {
  return raw.replace(/[\s\-()]/g, '')
}
const PHONE_RE = /^\+?1?\d{10,15}$/

function maskEmail(email: string): string {
  const at = email.indexOf('@')
  return at > 0 ? `…${email.slice(at)}` : '…'
}
function maskPhone(phone: string): string {
  return `…${phone.replace(/[^0-9]/g, '').slice(-4)}`
}

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()

  // Same gate the builder itself needs to create/edit a campaign.
  const guard = await requirePermission(supabase, 'campaigns:write')
  if ('error' in guard) return guard.error
  const { orgId } = guard

  const parsed = testSendSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }
  const { channel, subject, body } = parsed.data

  // Recipient is derived ONLY from the authenticated staffer — never the body.
  const { data: profile } = await getOwnProfile(supabase, 'id, full_name, email, phone')
  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Personalize with obvious sample values so the message is clearly a preview.
  const previewBody = previewPersonalize(body)

  if (channel === 'sms') {
    // A2P 10DLC gate — refuse US SMS until this org's campaign is verified, same
    // as the mass-SMS route (the low-level sendSMS does not check this itself).
    const orgFlags = await getOrgFlags(supabase, orgId)
    if (isUsSmsBlocked(orgFlags)) {
      return NextResponse.json({ error: A2P_PENDING_MESSAGE, a2p_pending: true }, { status: 403 })
    }

    const rawPhone = (decryptField(profile.phone as string | null) || (profile.phone as string | null) || '').trim()
    const phone = rawPhone ? normalizePhone(rawPhone) : ''
    if (!phone || !PHONE_RE.test(phone)) {
      return NextResponse.json(
        {
          error: 'Add your mobile number under Settings → Your Profile to send yourself an SMS test.',
          code: 'no_staff_phone',
        },
        { status: 422 }
      )
    }

    try {
      const result = await sendSMS(phone, `[TEST] ${previewBody}`)
      const suppressed = result.status === 'blocked'
      return NextResponse.json({
        ok: true,
        channel,
        recipient_masked: maskPhone(phone),
        delivery: suppressed ? 'suppressed' : 'sent',
      })
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Failed to send test SMS' },
        { status: 502 }
      )
    }
  }

  // channel === 'email' — recipient is the staffer's own account email.
  const to = (profile.email as string | null)?.trim() || ''
  if (!to) {
    return NextResponse.json({ error: 'Your profile has no email on file.' }, { status: 422 })
  }

  const previewSubject = previewPersonalize(subject?.trim() || 'Campaign step preview')
  const html = `<p style="margin:0 0 12px;padding:8px 12px;background:#f3f4f6;border-radius:6px;font:600 12px/1.4 sans-serif;color:#6b7280">TEST PREVIEW — sent to you from the campaign builder</p>` +
    `<div>${previewBody.replace(/\n/g, '<br>')}</div>`

  try {
    const result = await sendEmail({
      to,
      subject: `[TEST] ${previewSubject}`,
      html,
      text: previewBody,
      from: transactionalFrom(),
      replyTo: to,
    })
    const suppressed = result.id === 'dry-run' || result.id === 'blocked-by-test-allowlist'
    return NextResponse.json({
      ok: true,
      channel,
      recipient_masked: maskEmail(to),
      delivery: suppressed ? 'suppressed' : 'sent',
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to send test email' },
      { status: 502 }
    )
  }
}
