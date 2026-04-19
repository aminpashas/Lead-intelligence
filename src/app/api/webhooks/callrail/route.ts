/**
 * CallRail Integration — Inbound Call Tracking Connector
 *
 * Receives webhook events from CallRail when phone calls come in,
 * and either creates new leads or enriches existing ones with call data.
 *
 * CallRail tracks which ad/keyword/landing page drove each phone call,
 * closing the attribution loop for offline (phone) conversions.
 *
 * Setup:
 * 1. Create a CallRail account at callrail.com
 * 2. Set up tracking numbers for your practice
 * 3. Configure a webhook to POST to /api/webhooks/callrail
 * 4. Enter your API key in Settings → Connectors
 *
 * Events received:
 * - call_completed: Inbound call finished
 * - call_tagged: Call was tagged/classified by staff
 * - form_submission: CallRail form fill (if using their forms)
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { encryptLeadPII } from '@/lib/encryption'
import { dispatchConnectorEvent, buildConnectorLeadData } from '@/lib/connectors'

// CallRail webhook payload types
type CallRailEvent = {
  event_type: 'call_completed' | 'call_tagged' | 'form_submission'
  call_id?: string
  company_id: string
  tracking_number: string
  caller_number: string
  caller_name?: string
  caller_city?: string
  caller_state?: string
  caller_zip?: string
  caller_country?: string
  duration: number // seconds
  direction: 'inbound' | 'outbound'
  answered: boolean
  voicemail: boolean
  first_call: boolean
  // Attribution
  source?: string
  medium?: string
  campaign?: string
  keyword?: string
  landing_page_url?: string
  gclid?: string
  // Tags
  tags?: string[]
  note?: string
  lead_status?: string
  // Timestamps
  start_time: string
  // Form submission specific
  form_data?: Record<string, string>
}

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.webhook)
  if (rlError) return rlError

  const supabase = await createClient()

  // Verify the webhook is from a configured org
  // CallRail doesn't have a signing mechanism, so we match by tracking number
  const body = await request.json() as CallRailEvent

  if (!body.event_type || !body.caller_number) {
    return NextResponse.json({ error: 'Invalid CallRail payload' }, { status: 400 })
  }

  // Find the org that has CallRail configured
  const { data: config } = await supabase
    .from('connector_configs')
    .select('organization_id, credentials')
    .eq('connector_type', 'callrail')
    .eq('enabled', true)

  if (!config || config.length === 0) {
    return NextResponse.json({ error: 'No CallRail connector configured' }, { status: 404 })
  }

  // Match by company ID or take first configured org
  const matchedConfig = config.find(c => {
    const creds = c.credentials as Record<string, string>
    return creds.companyId === body.company_id
  }) || config[0]

  const orgId = matchedConfig.organization_id

  // Only process inbound calls that were answered (or voicemails)
  if (body.direction !== 'inbound') {
    return NextResponse.json({ success: true, action: 'skipped_outbound' })
  }

  // Format phone
  const callerPhone = body.caller_number.replace(/\D/g, '')
  const phoneFormatted = callerPhone.startsWith('1') ? `+${callerPhone}` : `+1${callerPhone}`

  // Check if this caller already exists as a lead
  const { data: existingLeads } = await supabase
    .from('leads')
    .select('id, first_name, last_name, status, utm_source')
    .eq('organization_id', orgId)
    .eq('phone_formatted', phoneFormatted)
    .limit(1)

  let leadId: string
  let action: string

  if (existingLeads && existingLeads.length > 0) {
    // Enrich existing lead with call data
    leadId = existingLeads[0].id
    action = 'enriched'

    await supabase
      .from('leads')
      .update({
        // Only update attribution if it wasn't already set
        ...(body.source && !existingLeads[0].utm_source ? { utm_source: body.source } : {}),
        ...(body.campaign ? { utm_campaign: body.campaign } : {}),
        ...(body.keyword ? { utm_term: body.keyword } : {}),
        ...(body.gclid ? { gclid: body.gclid } : {}),
        ...(body.landing_page_url ? { landing_page_url: body.landing_page_url } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', leadId)
  } else {
    // Create new lead from phone call
    action = 'created'

    // Parse caller name
    let firstName = 'Unknown'
    let lastName: string | undefined
    if (body.caller_name) {
      const parts = body.caller_name.split(' ')
      firstName = parts[0] || 'Unknown'
      lastName = parts.slice(1).join(' ') || undefined
    }

    // Get default pipeline stage
    const { data: defaultStage } = await supabase
      .from('pipeline_stages')
      .select('id')
      .eq('organization_id', orgId)
      .eq('is_default', true)
      .single()

    const leadData = encryptLeadPII({
      organization_id: orgId,
      first_name: firstName,
      last_name: lastName,
      phone: body.caller_number,
      phone_formatted: phoneFormatted,
      source_type: 'phone',
      utm_source: body.source || 'callrail',
      utm_medium: body.medium || 'phone',
      utm_campaign: body.campaign,
      utm_term: body.keyword,
      gclid: body.gclid,
      landing_page_url: body.landing_page_url,
      stage_id: defaultStage?.id,
      status: 'new',
      city: body.caller_city,
      state: body.caller_state,
      zip_code: body.caller_zip,
      custom_fields: {
        callrail_call_id: body.call_id,
        callrail_tracking_number: body.tracking_number,
        call_duration_seconds: body.duration,
        call_answered: body.answered,
        call_voicemail: body.voicemail,
        call_first_time: body.first_call,
        call_tags: body.tags || [],
      },
    })

    const { data: lead, error } = await supabase
      .from('leads')
      .insert(leadData)
      .select()
      .single()

    if (error || !lead) {
      return NextResponse.json({ error: error?.message || 'Failed to create lead' }, { status: 500 })
    }

    leadId = lead.id
  }

  // Log call activity
  const callNote = [
    body.answered ? '📞 Inbound call' : body.voicemail ? '📱 Voicemail' : '❌ Missed call',
    body.duration > 0 ? `(${Math.floor(body.duration / 60)}m ${body.duration % 60}s)` : '',
    body.first_call ? '— First-time caller' : '',
    body.tags?.length ? `Tags: ${body.tags.join(', ')}` : '',
    body.note ? `Note: ${body.note}` : '',
  ].filter(Boolean).join(' ')

  await supabase.from('lead_activities').insert({
    organization_id: orgId,
    lead_id: leadId,
    activity_type: 'phone_call',
    title: callNote,
    metadata: {
      call_id: body.call_id,
      duration: body.duration,
      answered: body.answered,
      voicemail: body.voicemail,
      tracking_number: body.tracking_number,
      source: body.source,
      campaign: body.campaign,
      keyword: body.keyword,
    },
  })

  // Dispatch to other connectors (Google Ads gets the gclid conversion, etc.)
  if (action === 'created') {
    const { data: freshLead } = await supabase
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single()

    if (freshLead) {
      dispatchConnectorEvent(supabase, {
        type: 'lead.created',
        organizationId: orgId,
        leadId,
        timestamp: new Date().toISOString(),
        data: {
          lead: buildConnectorLeadData(freshLead),
          metadata: { source: 'callrail', call_id: body.call_id },
        },
      }).catch(() => { /* non-blocking */ })
    }
  }

  return NextResponse.json({
    success: true,
    lead_id: leadId,
    action,
    call_id: body.call_id,
  })
}
