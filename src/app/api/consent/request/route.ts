/**
 * POST /api/consent/request — staff-triggered consent-capture (Phase 1.2).
 *
 * Creates a single-use opt-in token for a lead and emails them the hosted opt-in
 * link. Gated by the org `consent_capture` feature flag. The opt-in email is a
 * transactional, relationship message to a lead who already reached out via the
 * DGS form — it is NOT marketing, so it sends via the low-level sendEmail (not
 * the consent gate, which the lead has not yet passed). We still refuse to email
 * anyone who explicitly declined or unsubscribed.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { decryptField } from '@/lib/encryption'
import { getOrgFlags, flagOn } from '@/lib/org/flags'
import { sendEmail } from '@/lib/messaging/resend'
import { appendEmailFooter, getUnsubscribeHeaders } from '@/lib/messaging/email-footer'
import { getOrgPostalAddress } from '@/lib/content/practice-assets'
import {
  generateConsentToken,
  consentTokenExpiry,
  buildOptInUrl,
  optInEmailTemplate,
  type ConsentCaptureChannel,
} from '@/lib/consent/capture'

export async function POST(request: NextRequest) {
  // Staff auth → resolve org.
  const authed = await createClient()
  const { data: { user } } = await authed.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await authed
    .from('user_profiles')
    .select('organization_id')
    .eq('id', user.id)
    .single()
  const organizationId = profile?.organization_id
  if (!organizationId) return NextResponse.json({ error: 'No organization' }, { status: 403 })

  const body = (await request.json().catch(() => null)) as { lead_id?: string; channels?: string[] } | null
  const leadId = body?.lead_id
  if (!leadId) return NextResponse.json({ error: 'lead_id is required' }, { status: 400 })

  const channels: ConsentCaptureChannel[] = (body?.channels ?? ['sms', 'email']).filter(
    (c): c is ConsentCaptureChannel => c === 'sms' || c === 'email' || c === 'voice'
  )

  const service = createServiceClient()

  // Feature flag gate.
  const flags = await getOrgFlags(service, organizationId)
  if (!flagOn(flags, 'consent_capture')) {
    return NextResponse.json({ error: 'consent_capture_disabled' }, { status: 409 })
  }

  // Load the lead (scoped to org) + the org name for the email.
  const { data: lead } = await service
    .from('leads')
    .select('id, first_name, email, email_consent_status, email_opt_out')
    .eq('id', leadId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

  const email = lead.email ? (decryptField(lead.email) || lead.email) : null
  if (!email) return NextResponse.json({ error: 'lead_has_no_email' }, { status: 422 })
  if (lead.email_opt_out === true || lead.email_consent_status === 'declined') {
    return NextResponse.json({ error: 'lead_declined_contact' }, { status: 409 })
  }

  const { data: org } = await service
    .from('organizations')
    .select('name')
    .eq('id', organizationId)
    .maybeSingle()

  // Mint + persist the token.
  const token = generateConsentToken()
  const { data: inserted, error: insertErr } = await service
    .from('consent_capture_tokens')
    .insert({
      organization_id: organizationId,
      lead_id: leadId,
      token,
      channels,
      expires_at: consentTokenExpiry(),
    })
    .select('id')
    .single()
  if (insertErr || !inserted) {
    return NextResponse.json({ error: insertErr?.message ?? 'token_create_failed' }, { status: 500 })
  }

  // Send the opt-in email.
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || ''
  if (!baseUrl) return NextResponse.json({ error: 'app_url_not_configured' }, { status: 500 })
  const url = buildOptInUrl(baseUrl, token)
  const tmpl = optInEmailTemplate({ orgName: org?.name ?? '', firstName: lead.first_name, url, channels })
  const orgAddress = await getOrgPostalAddress(service, organizationId)
  const html = appendEmailFooter(tmpl.html, { leadId, orgId: organizationId, orgName: org?.name ?? '', address: orgAddress })

  try {
    await sendEmail({
      to: email,
      subject: tmpl.subject,
      html,
      text: tmpl.text,
      headers: getUnsubscribeHeaders(leadId, organizationId),
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'email_send_failed', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 502 }
    )
  }

  return NextResponse.json({ ok: true, token_id: inserted.id }, { status: 201 })
}
