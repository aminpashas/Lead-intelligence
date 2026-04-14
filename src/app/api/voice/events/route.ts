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

  // Send email follow-up via Resend
  if (wantsEmail && extracted && 'email' in extracted && extracted.email) {
    const toEmail = extracted.email as string
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'reconstruction@dionhealth.com'
    const resendKey = process.env.RESEND_API_KEY

    if (resendKey && toEmail) {
      try {
        const htmlEmail = buildPostCallEmail({
          firstName,
          practiceName,
          wantsPricing,
          wantsAppointment,
        })

        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: `${practiceName} <${fromEmail}>`,
            to: [toEmail],
            subject: `Thanks for calling ${practiceName} — here's what we discussed`,
            html: htmlEmail,
          }),
        })

        if (emailRes.ok) {
          console.log(`[Voice Events] Post-call email sent to ${toEmail}`)

          // Log to conversation
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
              channel: 'email',
              body: `Post-call summary email sent to ${toEmail}`,
              sender_type: 'ai',
              status: 'sent',
              ai_generated: true,
              metadata: { trigger: 'post_call_followup_email', to_email: toEmail },
            })
          }
        } else {
          const err = await emailRes.text()
          console.error('[Voice Events] Resend email failed:', emailRes.status, err)
        }
      } catch (emailErr) {
        console.error('[Voice Events] Email send error:', emailErr)
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// EMAIL TEMPLATE — Branded post-call HTML email
// ═══════════════════════════════════════════════════════════════

function buildPostCallEmail(params: {
  firstName: string
  practiceName: string
  wantsPricing: boolean
  wantsAppointment: boolean
}): string {
  const { firstName, practiceName, wantsPricing, wantsAppointment } = params

  const pricingSection = wantsPricing ? `
    <div style="background:#f0f9ff;border-left:4px solid #0ea5e9;padding:20px 24px;margin:24px 0;border-radius:0 8px 8px 0;">
      <h3 style="margin:0 0 12px;color:#0369a1;font-size:16px;font-weight:700;">📋 All-on-4 Investment Overview</h3>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:6px 0;color:#374151;font-size:14px;">• Single arch restoration</td><td style="padding:6px 0;color:#0369a1;font-weight:600;text-align:right;">$20,000 – $30,000</td></tr>
        <tr><td style="padding:6px 0;color:#374151;font-size:14px;">• Full mouth (both arches)</td><td style="padding:6px 0;color:#0369a1;font-weight:600;text-align:right;">$40,000 – $60,000</td></tr>
        <tr><td style="padding:6px 0;color:#374151;font-size:14px;">• Monthly financing options</td><td style="padding:6px 0;color:#0369a1;font-weight:600;text-align:right;">From ~$500–800/mo</td></tr>
        <tr><td style="padding:6px 0;color:#374151;font-size:14px;">• Insurance benefit (typical)</td><td style="padding:6px 0;color:#0369a1;font-weight:600;text-align:right;">$1,500 – $3,000</td></tr>
        <tr><td style="padding:6px 0;color:#374151;font-size:14px;">• HSA / FSA eligible</td><td style="padding:6px 0;color:#10b981;font-weight:600;text-align:right;">✓ Pre-tax savings</td></tr>
      </table>
    </div>` : ''

  const appointmentSection = wantsAppointment ? `
    <div style="background:#f0fdf4;border-left:4px solid #22c55e;padding:20px 24px;margin:24px 0;border-radius:0 8px 8px 0;">
      <h3 style="margin:0 0 12px;color:#15803d;font-size:16px;font-weight:700;">📅 Your Free Consultation Includes</h3>
      <ul style="margin:0;padding-left:20px;color:#374151;font-size:14px;line-height:2;">
        <li>60–90 minute one-on-one with our specialist</li>
        <li>Full 3D CT scan (no additional charge)</li>
        <li>Personalized treatment plan</li>
        <li>Complete pricing breakdown</li>
        <li>Financing pre-qualification on the spot</li>
      </ul>
    </div>` : ''

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1e3a5f 0%,#0ea5e9 100%);padding:40px 40px 32px;text-align:center;">
      <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">${practiceName}</h1>
      <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">All-on-4 Implant Specialists</p>
    </div>

    <!-- Body -->
    <div style="padding:40px;">
      <h2 style="margin:0 0 8px;color:#111827;font-size:20px;font-weight:700;">Hi ${firstName}! 👋</h2>
      <p style="margin:0 0 20px;color:#6b7280;font-size:15px;line-height:1.6;">
        Thank you so much for calling us today. We loved speaking with you about your smile goals. Here's a quick summary of what we discussed:
      </p>

      ${pricingSection}
      ${appointmentSection}

      <!-- CTA -->
      <div style="text-align:center;margin:32px 0;">
        <a href="tel:+14158861942" style="display:inline-block;background:linear-gradient(135deg,#0ea5e9,#0369a1);color:#ffffff;text-decoration:none;padding:16px 40px;border-radius:50px;font-size:16px;font-weight:700;letter-spacing:0.3px;">
          📞 Call Us Back
        </a>
      </div>

      <p style="margin:24px 0 0;color:#6b7280;font-size:14px;line-height:1.6;">
        Have questions? Just reply to this email or give us a call — we're here to help you take the next step toward a confident, permanent smile. 😊
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#f8fafc;padding:24px 40px;border-top:1px solid #e5e7eb;text-align:center;">
      <p style="margin:0;color:#9ca3af;font-size:12px;">
        ${practiceName} · This email was sent because you called our office today.<br>
        <a href="#" style="color:#9ca3af;">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`
}
