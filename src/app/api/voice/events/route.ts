/**
 * Retell Events Webhook — Call Lifecycle Events
 *
 * Receives events from Retell when calls start, end, or get analyzed.
 * Handles post-call processing: saving transcripts, recordings,
 * updating campaign queue status, and triggering follow-up actions.
 *
 * Events:
 * - call_started: Call is connected and audio is flowing
 * - call_ended: Call has ended (any reason)
 * - call_analyzed: Retell has completed post-call analysis
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { verifyRetellWebhook, type RetellWebhookEvent } from '@/lib/voice/retell-client'
import { processCallEnd } from '@/lib/voice/call-manager'
import { updateCampaignLeadAfterCall } from '@/lib/voice/campaign-dialer'
import { logger } from '@/lib/logger'
import type { VoiceCallStatus } from '@/types/database'

// POST /api/voice/events — Retell event webhook
export async function POST(request: NextRequest) {
  const rawBody = await request.text()

  // Verify webhook signature in production
  if (process.env.NODE_ENV === 'production') {
    const signature = request.headers.get('x-retell-signature') || ''
    if (!verifyRetellWebhook(rawBody, signature)) {
      return new NextResponse('Invalid signature', { status: 401 })
    }
  }

  let event: RetellWebhookEvent
  try {
    event = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const retellCallId = event.call?.call_id

  if (!retellCallId) {
    return NextResponse.json({ error: 'Missing call_id' }, { status: 400 })
  }

  // Find our call record by Retell call ID
  const { data: callRecord } = await supabase
    .from('voice_calls')
    .select('id, organization_id, lead_id, conversation_id, voice_campaign_id')
    .eq('retell_call_id', retellCallId)
    .single()

  logger.info('Retell event received', {
    event: event.event,
    retell_call_id: retellCallId,
    our_call_id: callRecord?.id,
  })

  switch (event.event) {
    case 'call_started': {
      if (callRecord) {
        await supabase
          .from('voice_calls')
          .update({
            status: 'in_progress' as VoiceCallStatus,
            answered_at: new Date().toISOString(),
            recording_disclosure_given: true, // Greeting includes disclosure
          })
          .eq('id', callRecord.id)
      }
      break
    }

    case 'call_ended': {
      if (callRecord) {
        // Full post-call processing
        await processCallEnd(supabase, callRecord.id, event.call)

        // Update campaign queue if this was a campaign call
        if (callRecord.voice_campaign_id) {
          // Get campaign for max_attempts
          const { data: campaign } = await supabase
            .from('voice_campaigns')
            .select('max_attempts_per_lead')
            .eq('id', callRecord.voice_campaign_id)
            .single()

          // Determine outcome from Retell data
          let outcome = event.call.disconnection_reason || 'completed'
          if (event.call.call_analysis?.call_successful) {
            outcome = 'interested'
          }

          await updateCampaignLeadAfterCall(
            supabase,
            callRecord.voice_campaign_id,
            callRecord.lead_id,
            outcome,
            campaign?.max_attempts_per_lead || 3
          )
        }

        // Multi-channel fallback: if outbound call wasn't answered, 
        // trigger SMS follow-up
        if (event.call.disconnection_reason === 'no_answer' ||
            event.call.disconnection_reason === 'voicemail_reached') {
          await triggerSMSFollowUp(supabase, callRecord)
        }
      }
      break
    }

    case 'call_analyzed': {
      // Retell completed post-call analysis — update with richer data
      if (callRecord && event.call.call_analysis) {
        await supabase
          .from('voice_calls')
          .update({
            transcript_summary: event.call.call_analysis.call_summary,
            metadata: {
              sentiment: event.call.call_analysis.user_sentiment,
              call_successful: event.call.call_analysis.call_successful,
              analysis_data: event.call.call_analysis.custom_analysis_data,
            },
          })
          .eq('id', callRecord.id)
      }
      break
    }

    default:
      logger.warn('Unknown Retell event', { event: event.event })
  }

  return NextResponse.json({ received: true })
}

/**
 * After a failed outbound call (no answer / voicemail), automatically
 * send an SMS follow-up using the existing SMS system.
 */
async function triggerSMSFollowUp(
  supabase: SupabaseClient,
  callRecord: { 
    id: string
    organization_id: string
    lead_id: string 
    conversation_id: string
  }
): Promise<void> {
  // Check if lead has SMS consent
  const { data: lead } = await supabase
    .from('leads')
    .select('sms_consent, sms_opt_out, phone_formatted, first_name')
    .eq('id', callRecord.lead_id)
    .single()

  if (!lead || !lead.sms_consent || lead.sms_opt_out || !lead.phone_formatted) {
    return
  }

  // Get org name
  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', callRecord.organization_id)
    .single()

  const practiceName = org?.name || 'our practice'
  const firstName = lead.first_name || ''

  // Send a gentle SMS follow-up
  try {
    const { sendSMS } = await import('@/lib/messaging/twilio')
    const { decryptField } = await import('@/lib/encryption')

    const phone = decryptField(lead.phone_formatted) || lead.phone_formatted

    const message = firstName
      ? `Hi ${firstName}! We just tried calling from ${practiceName} about your inquiry. No worries if you couldn't pick up — feel free to call us back or reply here and we'll chat! 😊`
      : `Hi! We just tried calling from ${practiceName} about your inquiry. Feel free to call us back or reply here! 😊`

    await sendSMS(phone, message)

    // Log the follow-up message
    await supabase.from('messages').insert({
      organization_id: callRecord.organization_id,
      conversation_id: callRecord.conversation_id,
      lead_id: callRecord.lead_id,
      direction: 'outbound',
      channel: 'sms',
      body: message,
      sender_type: 'ai',
      status: 'sent',
      ai_generated: true,
      metadata: { trigger: 'voice_call_missed_followup', voice_call_id: callRecord.id },
    })

    logger.info('SMS follow-up sent after missed voice call', {
      call_id: callRecord.id,
      lead_id: callRecord.lead_id,
    })
  } catch (error) {
    logger.error('Failed to send SMS follow-up after missed call', 
      { call_id: callRecord.id },
      error instanceof Error ? error : undefined
    )
  }
}

// Need the type import for the function parameter
import type { SupabaseClient } from '@supabase/supabase-js'
