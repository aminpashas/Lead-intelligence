/**
 * Content Delivery API — Manual cross-channel delivery
 *
 * POST — Send a specific content asset to a lead via SMS or email.
 * Used by staff from the CRM UI when they want to manually trigger
 * a content delivery (separate from AI-triggered deliveries).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { getAssetById, incrementUsage, recordDelivery } from '@/lib/content/practice-assets'
import { formatAssetForSMS, formatAssetForEmail } from '@/lib/content/delivery-templates'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { sendEmail } from '@/lib/messaging/resend'
import { decryptField } from '@/lib/encryption'
import { parseBranding } from '@/lib/branding/schema'
import { resolveBrandForContext } from '@/lib/branding/resolve-brand'

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(request: NextRequest) {
  // Authenticate and derive the effective org from the session. This route was
  // previously unauthenticated and trusted a body-supplied `organization_id`,
  // letting anyone send content to any tenant's patient from our number. The org
  // now comes only from the session (agency admins resolve to their entered
  // client), and every query below is scoped to it.
  const authed = await createServerClient()
  const { orgId } = await resolveActiveOrg(authed)
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const organization_id = orgId

  const body = await request.json()

  const {
    lead_id,
    conversation_id,
    content_asset_id,
    channel, // 'sms' | 'email'
  } = body

  if (!lead_id || !content_asset_id || !channel) {
    return NextResponse.json(
      { error: 'lead_id, content_asset_id, and channel are required' },
      { status: 400 }
    )
  }

  if (!['sms', 'email'].includes(channel)) {
    return NextResponse.json({ error: 'channel must be "sms" or "email"' }, { status: 400 })
  }

  const supabase = getServiceClient()

  // Get the content asset (scoped to the caller's org)
  const asset = await getAssetById(supabase, content_asset_id)
  if (!asset || asset.organization_id !== organization_id) {
    return NextResponse.json({ error: 'Content asset not found' }, { status: 404 })
  }

  // Get lead contact info + the columns that classify its service line.
  const { data: lead } = await supabase
    .from('leads')
    .select('first_name, phone_formatted, email, sms_consent, sms_opt_out, email_consent, email_opt_out, tags, custom_fields, utm_campaign, utm_source, campaign_attribution, landing_page_url')
    .eq('id', lead_id)
    .eq('organization_id', organization_id)
    .single()

  if (!lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  // Get org name + branding, then resolve the lead's per-service-line DBA so the
  // asset is signed with the right brand (Dion Health / TMJ center / SF Dentistry).
  const { data: org } = await supabase
    .from('organizations')
    .select('name, settings')
    .eq('id', organization_id)
    .single()

  const branding = parseBranding((org?.settings as Record<string, unknown> | null)?.branding)
  const orgName = resolveBrandForContext(branding, org?.name || 'our practice', {
    lead: lead as never,
  }).practiceName
  const leadName = decryptField(lead.first_name) || lead.first_name || ''

  // Opt-out (DND) check — consent is assumed unless the lead opted out.
  if (channel === 'sms') {
    if (lead.sms_opt_out) {
      return NextResponse.json({ error: 'Lead has opted out of SMS' }, { status: 403 })
    }

    const phone = lead.phone_formatted
      ? (decryptField(lead.phone_formatted) || lead.phone_formatted)
      : null

    if (!phone) {
      return NextResponse.json({ error: 'No phone number on file' }, { status: 400 })
    }

    const smsContent = formatAssetForSMS(asset, leadName, orgName)

    try {
      const sendRes = await sendSMSToLead({ supabase, leadId: lead_id, to: phone, body: smsContent, caller: 'content.deliver' })
      if (!sendRes.sent) {
        return NextResponse.json({ error: 'Message blocked', reason: sendRes.reason }, { status: 403 })
      }
      const result = { sid: sendRes.sid }
      await incrementUsage(supabase, content_asset_id)

      // Store message
      const { data: message } = await supabase
        .from('messages')
        .insert({
          organization_id,
          conversation_id: conversation_id || null,
          lead_id,
          direction: 'outbound',
          channel: 'sms',
          body: smsContent,
          sender_type: 'user',
          status: 'sent',
          external_id: result.sid,
          metadata: { content_asset_id, manual_delivery: true },
        })
        .select('id')
        .single()

      // Track delivery
      if (conversation_id) {
        await recordDelivery(supabase, {
          organization_id,
          lead_id,
          conversation_id,
          triggered_by_channel: 'web_chat', // manual from CRM UI
          delivered_via_channel: 'sms',
          content_type: asset.type,
          content_asset_id,
          message_id: message?.id,
          status: 'sent',
          tool_name: 'manual_delivery',
        })
      }

      return NextResponse.json({ success: true, message_id: message?.id })
    } catch (error) {
      return NextResponse.json(
        { error: `SMS delivery failed: ${error instanceof Error ? error.message : 'Unknown'}` },
        { status: 500 }
      )
    }
  } else {
    // Email delivery — consent is assumed unless the lead opted out.
    if (lead.email_opt_out) {
      return NextResponse.json({ error: 'Lead has opted out of email' }, { status: 403 })
    }

    const email = lead.email
      ? (decryptField(lead.email) || lead.email)
      : null

    if (!email) {
      return NextResponse.json({ error: 'No email address on file' }, { status: 400 })
    }

    const emailContent = formatAssetForEmail(asset, leadName, orgName, {
      leadId: lead_id,
      orgId: organization_id,
    })

    try {
      const result = await sendEmail({
        to: email,
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text,
      })

      await incrementUsage(supabase, content_asset_id)

      // Store message
      const { data: message } = await supabase
        .from('messages')
        .insert({
          organization_id,
          conversation_id: conversation_id || null,
          lead_id,
          direction: 'outbound',
          channel: 'email',
          body: emailContent.text,
          sender_type: 'user',
          status: 'sent',
          external_id: result.id,
          metadata: { content_asset_id, subject: emailContent.subject, manual_delivery: true },
        })
        .select('id')
        .single()

      // Track delivery
      if (conversation_id) {
        await recordDelivery(supabase, {
          organization_id,
          lead_id,
          conversation_id,
          triggered_by_channel: 'web_chat',
          delivered_via_channel: 'email',
          content_type: asset.type,
          content_asset_id,
          message_id: message?.id,
          status: 'sent',
          tool_name: 'manual_delivery',
        })
      }

      return NextResponse.json({ success: true, message_id: message?.id })
    } catch (error) {
      return NextResponse.json(
        { error: `Email delivery failed: ${error instanceof Error ? error.message : 'Unknown'}` },
        { status: 500 }
      )
    }
  }
}
