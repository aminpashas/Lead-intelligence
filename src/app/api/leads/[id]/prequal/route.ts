/**
 * POST /api/leads/[id]/prequal — staff-facing "Send Pre-Qual" action.
 *
 * The MANUAL, human-in-the-loop path for financing pre-qualification. A staffer
 * decides a specific lead is engaged enough and clicks the button; nothing here
 * runs on a schedule, a score, or an AI decision. The AI's own readiness
 * auto-trigger (src/lib/financing/readiness.ts) is gated behind a *separate*
 * flag (`financing_auto_send_enabled`, default OFF) precisely so this stays the
 * only way financing goes out while the practice's focus is rapport → booked
 * consult.
 *
 * Two gates apply:
 *   1. Org must have `financing_prequal_enabled` on (Settings → Financing). Off
 *      → 403, and the button never renders in the first place.
 *   2. The send itself is consent-gated at the messaging layer (twilio.ts /
 *      resend.ts hard-block opted-out / no-consent leads), same as every other
 *      outbound path.
 *
 * The message is deliberately claim-free: it invites the patient to *check* what
 * they prequalify for via a soft check. It never states an approval or a dollar
 * amount the lender hasn't returned (see the financing false-approval guard).
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { isFlagEnabled } from '@/lib/org/flags'
import { getOrCreateFinancingShareLink } from '@/lib/financing/share-link'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { sendEmailToLead } from '@/lib/messaging/resend'
import { decryptField } from '@/lib/encryption'
import { auditPHITransmission } from '@/lib/hipaa-audit'
import { escapeHtml } from '@/lib/utils'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await getOwnProfile(supabase, 'id')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Gate 1 — the account-level toggle. Fail closed.
  const prequalOn = await isFlagEnabled(supabase, orgId, 'financing_prequal_enabled')
  if (!prequalOn) {
    return NextResponse.json(
      { error: 'Pre-qualification is turned off for this account. Enable it in Settings → Financing.' },
      { status: 403 }
    )
  }

  // Lead must exist in this org (RLS + explicit scope = defense in depth).
  const { data: lead } = await supabase
    .from('leads')
    .select('id, organization_id, first_name, phone, phone_formatted, email, sms_opt_out, email_opt_out, treatment_value')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

  // Decrypt contact info (stored encrypted at rest).
  const phone = lead.phone_formatted
    ? decryptField(lead.phone_formatted)
    : lead.phone ? decryptField(lead.phone) : null
  const email = lead.email ? decryptField(lead.email) : null

  // Nothing reachable at all — tell the staffer plainly rather than silently no-op.
  const smsReachable = !!phone && !lead.sms_opt_out
  const emailReachable = !!email && !lead.email_opt_out
  if (!smsReachable && !emailReachable) {
    return NextResponse.json(
      { error: 'No available channel — this lead has no consented phone or email (or both are muted).' },
      { status: 400 }
    )
  }

  // Reuse the shared share-link helper: creates (or reuses) a pending
  // application + `/finance/{token}` URL on the stable prod host. Prequal does
  // not require a treatment amount — pass it through if we have one so the
  // patient's page can personalize, else null.
  const link = await getOrCreateFinancingShareLink(supabase, {
    organizationId: orgId,
    leadId: id,
    requestedAmount: lead.treatment_value ?? null,
  })
  if (!link) {
    return NextResponse.json({ error: 'Could not create financing link' }, { status: 500 })
  }

  const firstName = lead.first_name || 'there'
  // Claim-free copy: invite them to CHECK what they prequalify for. No approval,
  // no dollar figure the lender hasn't returned.
  const smsBody =
    `Hi ${firstName}! If it'd help, you can check what payment options you prequalify for in about 2 minutes — ` +
    `it's a soft check that won't affect your credit: ${link.url} No pressure, just here if it's useful!`

  const safeFirstName = escapeHtml(firstName)
  const emailSubject = 'Check your financing options'
  const emailBody = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;color:#111;">
      <p>Hi ${safeFirstName},</p>
      <p>If it would be helpful, you can check what payment options you prequalify for — it only takes a couple of minutes and uses a <strong>soft credit check that won't affect your credit score</strong>.</p>
      <p><a href="${escapeHtml(link.url)}" style="background:#10b981;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;display:inline-block;font-weight:bold;">See my options</a></p>
      <p>No pressure at all — it's just here if it's useful. Questions? Just reply.</p>
    </div>
  `

  const sentVia: string[] = []

  // SMS first (higher engagement), then email fallback. Each call is
  // consent-gated inside the messaging layer, so a blocked channel returns
  // { sent: false } rather than throwing.
  if (smsReachable && phone) {
    try {
      await auditPHITransmission(
        { supabase, organizationId: orgId, actorType: 'user' },
        'lead', id, 'twilio_sms', ['phone']
      )
      const res = await sendSMSToLead({ supabase, leadId: id, to: phone, body: smsBody, caller: 'financing.prequal-manual' })
      if (res.sent) sentVia.push('sms')
    } catch {
      /* fall through to email */
    }
  }

  if (sentVia.length === 0 && emailReachable && email) {
    try {
      await auditPHITransmission(
        { supabase, organizationId: orgId, actorType: 'user' },
        'lead', id, 'resend_email', ['email']
      )
      const res = await sendEmailToLead({ supabase, leadId: id, to: email, subject: emailSubject, html: emailBody, caller: 'financing.prequal-manual' })
      if (res.sent) sentVia.push('email')
    } catch {
      /* nothing sent — reported below */
    }
  }

  if (sentVia.length === 0) {
    return NextResponse.json(
      { error: 'Message blocked — no messaging consent on the available channel(s).' },
      { status: 403 }
    )
  }

  // Stamp the send + link the application so the readiness auto-trigger's
  // "already sent recently" guard also respects this manual send.
  await supabase
    .from('leads')
    .update({ financing_link_sent_at: new Date().toISOString(), financing_application_id: link.applicationId })
    .eq('id', id)
    .eq('organization_id', orgId)

  // Activity breadcrumb — distinct type so manual prequal sends are separable
  // from the AI auto-trigger's `financing_link_auto_sent`.
  try {
    await supabase.from('lead_activities').insert({
      organization_id: orgId,
      lead_id: id,
      activity_type: 'financing_prequal_manual_sent',
      title: `Pre-qualification link sent via ${sentVia.join(' & ')}`,
      description: `Manual staff send. Patient link: ${link.url}`,
      metadata: {
        application_id: link.applicationId,
        share_token: link.shareToken,
        sent_via: sentVia,
        trigger: 'manual_button',
        actor: profile.id,
      },
    })
  } catch {
    /* breadcrumb only */
  }

  return NextResponse.json({ success: true, lead_id: id, financing_url: link.url, sent_via: sentVia })
}
