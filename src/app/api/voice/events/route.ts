/**
 * Retell Events Webhook — Post-Call Processing
 *
 * When a call ends, Retell sends an event here.
 * Uses the unified encounter processor for consistent data flow
 * across Voice, SMS, and Email channels.
 */

import { NextRequest, NextResponse } from 'next/server'
import { processEncounter, extractFromTranscript } from '@/lib/ai/encounter-processor'

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

  } catch (error) {
    console.error('[Voice Events] Error:', error)
  }

  return NextResponse.json({ received: true })
}
