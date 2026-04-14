/**
 * Content Delivery API — Manual cross-channel delivery
 *
 * POST — Send a specific content asset to a lead via SMS or email.
 * Used by staff from the CRM UI when they want to manually trigger
 * a content delivery (separate from AI-triggered deliveries).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAssetById, incrementUsage, recordDelivery } from '@/lib/content/practice-assets'
import { formatAssetForSMS, formatAssetForEmail } from '@/lib/content/delivery-templates'
import { sendSMS } from '@/lib/messaging/twilio'
import { sendEmail } from '@/lib/messaging/resend'
import { decryptField } from '@/lib/encryption'

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(request: NextRequest) {
  const body = await request.json()

  const {
    organization_id,
    lead_id,
    conversation_id,
    content_asset_id,
    channel, // 'sms' | 'email'
  } = body

  if (!organization_id || !lead_id || !content_asset_id || !channel) {
    return NextResponse.json(
      { error: 'organization_id, lead_id, content_asset_id, and channel are required' },
      { status: 400 }
    )
  }

  if (!['sms', 'email'].includes(channel)) {
    return NextResponse.json({ error: 'channel must be "sms" or "email"' }, { status: 400 })
  }

  const supabase = getServiceClient()

  // Get the content asset
  const asset = await getAssetById(supabase, content_asset_id)
  if (!asset) {
    return NextResponse.json({ error: 'Content asset not found' }, { status: 404 })
  }

  // Get lead contact info
  const { data: lead } = await supabase
    .from('leads')
    .select('first_name, phone_formatted, email, sms_consent, sms_opt_out, email_consent, email_opt_out')
    .eq('id', lead_id)
    .eq('organization_id', organization_id)
    .single()

  if (!lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  // Get org name
  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', organization_id)
    .single()

  const orgName = org?.name || 'our practice'
  const leadName = decryptField(lead.first_name) || lead.first_name || ''

  // Consent check
  if (channel === 'sms') {
    if (!lead.sms_consent || lead.sms_opt_out) {
      return NextResponse.json({ error: 'Lead has not given SMS consent or has opted out' }, { status: 403 })
    }

    const phone = lead.phone_formatted
      ? (decryptField(lead.phone_formatted) || lead.phone_formatted)
      : null

    if (!phone) {
      return NextResponse.json({ error: 'No phone number on file' }, { status: 400 })
    }

    const smsContent = formatAssetForSMS(asset, leadName, orgName)

    try {
      const result = await sendSMS(phone, smsContent)
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
    // Email delivery
    if (!lead.email_consent || lead.email_opt_out) {
      return NextResponse.json({ error: 'Lead has not given email consent or has opted out' }, { status: 403 })
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
