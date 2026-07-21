import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, requirePermission } from '@/lib/auth/active-org'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { decryptField, searchHash } from '@/lib/encryption'
import { formatToE164 } from '@/lib/leads/phone'
import { previewPersonalize } from '@/lib/campaigns/personalization'
import { sendSMS } from '@/lib/messaging/twilio'
import { sendEmail, transactionalFrom } from '@/lib/messaging/resend'
import { getOrgFlags } from '@/lib/org/flags'
import { isUsSmsBlocked, A2P_PENDING_MESSAGE } from '@/lib/messaging/a2p-gate'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Send a single campaign step as a real SMS/email preview, so an admin can see
 * what a step looks like on a live device before blasting patients.
 *
 * The recipient is one of two things:
 *  - A staff-typed TEST number/email (`recipient` in the body), for testing on a
 *    colleague's device, a Google Voice line, etc.; OR
 *  - When `recipient` is omitted/blank, the LOGGED-IN STAFFER's own profile
 *    (their phone for SMS, their account email for email) — the original
 *    "send test to me" behavior.
 *
 * SAFETY (this touches live messaging):
 *  - Gated by `campaigns:write` (the same permission the builder needs to save a
 *    campaign) via requirePermission, which also resolves the effective org.
 *  - A staff-typed recipient is checked against this org's saved leads by its
 *    encrypted search hash (`phone_hash` / `email_hash`). If it matches a lead we
 *    refuse with `409 recipient_matches_lead` so an admin can't fat-finger a
 *    [TEST] message to a real patient; the client must re-send with
 *    `acknowledgeLeadMatch: true` to override deliberately. (The profile fallback
 *    is the staffer themselves, not a lead, so it skips this check.)
 *  - Personalization vars ({{first_name}} …) are replaced with obvious sample
 *    values (previewPersonalize → "John", etc.) and the body is prefixed [TEST],
 *    so the message reads as a preview.
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
  // Optional staff-typed test destination. Blank/omitted ⇒ send to my own profile.
  recipient: z.string().trim().max(320).optional(),
  // Set by the client's confirm dialog to override the saved-lead guard on purpose.
  acknowledgeLeadMatch: z.boolean().optional(),
})

// Same normalization the ring-my-phone bridge uses on a staff profile number.
function normalizePhone(raw: string): string {
  return raw.replace(/[\s\-()]/g, '')
}
const PHONE_RE = /^\+?1?\d{10,15}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function maskEmail(email: string): string {
  const at = email.indexOf('@')
  return at > 0 ? `…${email.slice(at)}` : '…'
}
function maskPhone(phone: string): string {
  return `…${phone.replace(/[^0-9]/g, '').slice(-4)}`
}

/**
 * Look up a saved lead in this org whose encrypted phone/email hash matches the
 * typed test destination. Returns a short display label if matched, else null.
 * `dest` must already be normalized the same way the hash was computed at ingest:
 * E.164 for phone (searchHash lowercases+trims), the raw address for email.
 */
async function findMatchingLead(
  supabase: SupabaseClient,
  orgId: string,
  channel: 'sms' | 'email',
  dest: string
): Promise<string | null> {
  const hash = searchHash(dest)
  if (!hash) return null
  const column = channel === 'sms' ? 'phone_hash' : 'email_hash'
  const { data } = await supabase
    .from('leads')
    .select('first_name, last_name')
    .eq('organization_id', orgId)
    .eq(column, hash)
    .limit(1)
  const lead = data?.[0]
  if (!lead) return null
  const first = (lead.first_name as string | null)?.trim() || ''
  const lastInitial = ((lead.last_name as string | null)?.trim() || '').charAt(0)
  const label = [first, lastInitial ? `${lastInitial}.` : ''].filter(Boolean).join(' ').trim()
  return label || 'a saved lead'
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
  const { channel, subject, body, recipient, acknowledgeLeadMatch } = parsed.data
  const typedRecipient = recipient?.trim() || ''

  // Profile is still needed as the fallback recipient when none is typed.
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

    let phone: string
    if (typedRecipient) {
      // Staff-typed test number: canonicalize the same way ingest does so the
      // saved-lead hash lookup lines up, and so Twilio gets an E.164 destination.
      const e164 = formatToE164(typedRecipient)
      if (!e164) {
        return NextResponse.json(
          { error: 'Enter a valid US phone number to send a test SMS.', code: 'invalid_recipient' },
          { status: 422 }
        )
      }
      // Refuse to text a real patient a [TEST] message unless explicitly overridden.
      if (!acknowledgeLeadMatch) {
        const leadLabel = await findMatchingLead(supabase, orgId, 'sms', e164)
        if (leadLabel) {
          return NextResponse.json(
            {
              error: `That number matches a saved lead (${leadLabel}). Send the [TEST] message to them anyway?`,
              code: 'recipient_matches_lead',
              lead_masked: leadLabel,
            },
            { status: 409 }
          )
        }
      }
      phone = e164
    } else {
      const rawPhone = (decryptField(profile.phone as string | null) || (profile.phone as string | null) || '').trim()
      phone = rawPhone ? normalizePhone(rawPhone) : ''
      if (!phone || !PHONE_RE.test(phone)) {
        return NextResponse.json(
          {
            error: 'Add your mobile number under Settings → Your Profile, or enter a test number, to send an SMS test.',
            code: 'no_staff_phone',
          },
          { status: 422 }
        )
      }
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

  // channel === 'email' — a typed test address, or the staffer's own account email.
  let to: string
  if (typedRecipient) {
    if (!EMAIL_RE.test(typedRecipient)) {
      return NextResponse.json(
        { error: 'Enter a valid email address to send a test email.', code: 'invalid_recipient' },
        { status: 422 }
      )
    }
    if (!acknowledgeLeadMatch) {
      const leadLabel = await findMatchingLead(supabase, orgId, 'email', typedRecipient)
      if (leadLabel) {
        return NextResponse.json(
          {
            error: `That email matches a saved lead (${leadLabel}). Send the [TEST] message to them anyway?`,
            code: 'recipient_matches_lead',
            lead_masked: leadLabel,
          },
          { status: 409 }
        )
      }
    }
    to = typedRecipient
  } else {
    to = (profile.email as string | null)?.trim() || ''
    if (!to) {
      return NextResponse.json({ error: 'Your profile has no email on file — enter a test email instead.' }, { status: 422 })
    }
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
