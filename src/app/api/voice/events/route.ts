/**
 * Retell Events Webhook — Post-Call Processing
 *
 * When a call ends, Retell sends an event here.
 * Uses the unified encounter processor for consistent data flow
 * across Voice, SMS, and Email channels.
 */

import { NextRequest, NextResponse } from 'next/server'
import { processEncounter, extractFromTranscript } from '@/lib/ai/encounter-processor'
import type { SupabaseClient } from '@supabase/supabase-js'

const RETELL_API_KEY = process.env.RETELL_API_KEY || ''

function getSupabase() {
  try {
    const { createClient } = require('@supabase/supabase-js')
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) return null
    return createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const event = body.event as string
  const call = body.call as Record<string, unknown> | undefined
  const retellCallId = call?.call_id as string

  if (!retellCallId) {
    return NextResponse.json({ error: 'Missing call_id' }, { status: 400 })
  }

  console.log(`[Voice Events] Event: ${event}, Call: ${retellCallId}`)

  if (event !== 'call_ended' && event !== 'call_analyzed') {
    return NextResponse.json({ received: true })
  }

  const supabase = getSupabase()
  if (!supabase) {
    console.error('[Voice Events] No Supabase client')
    return NextResponse.json({ received: true })
  }

  try {
    // ── 1. Fetch full call data from Retell ──
    const retellRes = await fetch(`https://api.retellai.com/v2/get-call/${retellCallId}`, {
      headers: { 'Authorization': `Bearer ${RETELL_API_KEY}` },
    })

    if (!retellRes.ok) {
      console.error('[Voice Events] Retell fetch failed:', retellRes.status)
      return NextResponse.json({ received: true })
    }

    const callData = await retellRes.json()
    const transcript = (callData.transcript || '') as string
    const recordingUrl = (callData.recording_url || '') as string
    const callAnalysis = (callData.call_analysis || {}) as Record<string, unknown>
    const callDuration = (callData.call_cost?.total_duration_seconds || 0) as number
    const callMetadata = (callData.metadata || {}) as Record<string, unknown>
    const disconnectionReason = (callData.disconnection_reason || '') as string

    // ── 2. Resolve lead/org (from metadata or phone fallback) ──
    let leadId = callMetadata.lead_id as string | null
    let orgId = callMetadata.organization_id as string | null
    let conversationId = callMetadata.conversation_id as string | null

    if ((!leadId || !orgId) && callData.from_number) {
      const callerPhone = callData.from_number as string
      const normalizedPhone = callerPhone.replace(/^\+1/, '').replace(/\D/g, '')
      const phoneVariants = [callerPhone, normalizedPhone, `+1${normalizedPhone}`]

      if (!orgId) {
        const { data: firstOrg } = await supabase
          .from('organizations').select('id')
          .order('created_at', { ascending: true }).limit(1).single()
        orgId = firstOrg?.id || null
      }

      if (orgId && !leadId) {
        const { data: phoneLead } = await supabase
          .from('leads').select('id')
          .eq('organization_id', orgId)
          .or([
            ...phoneVariants.map(p => `phone.eq.${p}`),
            ...phoneVariants.map(p => `phone_formatted.eq.${p}`),
          ].join(','))
          .limit(1).single()
        leadId = phoneLead?.id || null
      }

      if (orgId && leadId && !conversationId) {
        const { data: conv } = await supabase
          .from('conversations').select('id')
          .eq('organization_id', orgId)
          .eq('lead_id', leadId)
          .order('created_at', { ascending: false }).limit(1).single()
        conversationId = conv?.id || null
      }
    }

    if (!transcript || !leadId || !orgId) {
      console.log('[Voice Events] Missing data, skipping', { leadId, orgId, hasTranscript: !!transcript })
      return NextResponse.json({ received: true })
    }

    // ── 3. Extract caller info ──
    const extracted = extractFromTranscript(transcript)

    // ── 4. Process through unified encounter processor ──
    await processEncounter({
      channel: 'voice',
      orgId,
      leadId,
      conversationId,
      transcript,
      summary: (callAnalysis.call_summary as string) || null,
      sentiment: (callAnalysis.user_sentiment as string) || null,
      callSuccessful: !!callAnalysis.call_successful,
      durationSeconds: callDuration,
      recordingUrl,
      retellCallId,
      extractedInfo: extracted,
    })

    // ── 5. Update voice_call record (voice-specific) ──
    const { data: existingCall } = await supabase
      .from('voice_calls').select('id')
      .eq('retell_call_id', retellCallId).single()

    if (existingCall) {
      await supabase.from('voice_calls').update({
        status: 'completed',
        ended_at: new Date().toISOString(),
        duration_seconds: callDuration,
        recording_url: recordingUrl,
        transcript: transcript.slice(0, 50000),
        transcript_summary: (callAnalysis.call_summary as string) || null,
        outcome: extracted.appointmentBooked ? 'appointment_booked'
          : (callAnalysis.call_successful ? 'interested' : disconnectionReason),
        sentiment: (callAnalysis.user_sentiment as string) || null,
        metadata: {
          ...callMetadata,
          call_analysis: callAnalysis,
          extracted_info: extracted,
          disconnection_reason: disconnectionReason,
        },
      }).eq('id', existingCall.id)
    }

    // ── 6. Post-call follow-up: send SMS/email if AI promised it ──
    // Detect common follow-up promises in the transcript and action them.
    await sendPostCallFollowUps(supabase, {
      orgId,
      leadId,
      transcript,
      extracted,
      callAnalysis,
    })

  } catch (error) {
    console.error('[Voice Events] Error:', error)
  }

  return NextResponse.json({ received: true })
}

// ═══════════════════════════════════════════════════════════════
// POST-CALL FOLLOW-UPS
// Detects when the AI promised to send info via SMS or email
// and actions it automatically after the call ends.
// ═══════════════════════════════════════════════════════════════

const RETELL_API_KEY_FOR_FOLLOWUP = process.env.RETELL_API_KEY || ''

async function sendPostCallFollowUps(
  supabase: SupabaseClient,
  params: {
    orgId: string
    leadId: string
    transcript: string
    extracted: Record<string, unknown>
    callAnalysis: Record<string, unknown>
  }
): Promise<void> {
  const { orgId, leadId, transcript, extracted } = params

  const t = transcript.toLowerCase()

  // Detect SMS follow-up request
  const wantsText = /send.{0,50}(text|sms|message)|text.{0,30}(info|detail|summary|price|cost)|i'll text|we'll text|sending.{0,30}text/i.test(transcript)
  // Detect email follow-up request
  const wantsEmail = /send.{0,50}(email|e-mail)|email.{0,30}(info|detail|summary|price|cost)|i'll email|we'll email|sending.{0,30}email/i.test(transcript)
  // Detect pricing request
  const wantsPricing = /price|cost|how much|financing|payment|afford/i.test(t)
  // Detect appointment booking intent
  const wantsAppointment = /schedul|appointment|book|consult|come in/i.test(t)

  // Only proceed if some follow-up was promised
  if (!wantsText && !wantsEmail) {
    return
  }

  console.log(`[Voice Events] Follow-up detected — text:${wantsText} email:${wantsEmail}`)

  // Get lead details
  const { data: lead } = await supabase
    .from('leads')
    .select('first_name, last_name, phone, phone_formatted, email, sms_consent, sms_opt_out')
    .eq('id', leadId)
    .single()

  if (!lead) return

  // Get org details
  const { data: org } = await supabase
    .from('organizations')
    .select('name, twilio_phone_number')
    .eq('id', orgId)
    .single()

  const practiceName = org?.name || 'our practice'
  const firstName = lead.first_name || 'there'

  // Build the follow-up message
  const lines: string[] = []
  lines.push(`Hi ${firstName}! Thanks for calling ${practiceName}. Here's what we discussed: 🦷`)
  lines.push('')

  if (wantsPricing) {
    lines.push('📋 ALL-ON-4 INVESTMENT OVERVIEW:')
    lines.push('• Single arch: $20,000–$30,000')
    lines.push('• Full mouth: $40,000–$60,000')
    lines.push('• Financing from ~$500–800/mo (60–84 months)')
    lines.push('• Most insurance covers $1,500–$3,000')
    lines.push('• HSA/FSA eligible (pre-tax savings!)')
    lines.push('')
  }

  if (wantsAppointment) {
    lines.push('📅 NEXT STEP: Schedule your FREE consultation')
    lines.push('• 60–90 minute appointment')
    lines.push('• 3D CT scan included')
    lines.push('• Custom treatment plan presented')
    lines.push('')
  }

  lines.push(`Ready to take the next step? Reply to this message or call us back. We'd love to meet you! 😊`)

  const messageBody = lines.join('\n')

  // Send SMS if requested and consent exists
  if (wantsText && lead.sms_consent && !lead.sms_opt_out) {
    const phone = lead.phone_formatted || lead.phone
    if (phone) {
      try {
        const twilio = await import('twilio')
        const client = twilio.default(
          process.env.TWILIO_ACCOUNT_SID,
          process.env.TWILIO_AUTH_TOKEN
        )
        await client.messages.create({
          body: messageBody,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: phone,
        })
        console.log(`[Voice Events] Post-call SMS sent to ${leadId}`)

        // Log the message to the conversation
        const { data: conv } = await supabase
          .from('conversations')
          .select('id')
          .eq('lead_id', leadId)
          .order('created_at', { ascending: false })
          .limit(1)
          .single()

        if (conv) {
          await supabase.from('messages').insert({
            organization_id: orgId,
            conversation_id: conv.id,
            lead_id: leadId,
            direction: 'outbound',
            channel: 'sms',
            body: messageBody,
            sender_type: 'ai',
            status: 'sent',
            ai_generated: true,
            metadata: { trigger: 'post_call_followup', retell_call_id: RETELL_API_KEY_FOR_FOLLOWUP },
          })
        }
      } catch (smsErr) {
        console.error('[Voice Events] Post-call SMS failed:', smsErr)
      }
    }
  }

  // TODO: Send email follow-up if wantsEmail && lead.email exists
  // (Requires Resend API key and verified domain — set RESEND_API_KEY in env)
  if (wantsEmail && extracted && 'email' in extracted && extracted.email) {
    console.log(`[Voice Events] Email follow-up requested but email sending not yet configured`)
  }
}
