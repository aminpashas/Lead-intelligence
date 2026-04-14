/**
 * Debug endpoint — Test the encounter processor by processing a specific Retell call
 * GET /api/voice/events/test?call_id=xxx
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

export async function GET(req: NextRequest) {
  const callId = req.nextUrl.searchParams.get('call_id')
  if (!callId) return NextResponse.json({ error: 'Missing call_id' }, { status: 400 })

  try {
    // 1. Fetch from Retell
    const retellRes = await fetch(`https://api.retellai.com/v2/get-call/${callId}`, {
      headers: { 'Authorization': `Bearer ${RETELL_API_KEY}` },
    })
    if (!retellRes.ok) return NextResponse.json({ error: `Retell ${retellRes.status}` }, { status: 500 })

    const callData = await retellRes.json()
    const transcript = callData.transcript || ''
    const callAnalysis = callData.call_analysis || {}
    const callDuration = callData.call_cost?.total_duration_seconds || 0

    // 2. Run extraction
    const extracted = extractFromTranscript(transcript)

    // 3. Find lead by phone
    const supabase = getSupabase()
    let leadId: string | null = null
    let orgId: string | null = null
    let conversationId: string | null = null

    if (supabase && callData.from_number) {
      const phone = callData.from_number
      const normalized = phone.replace(/^\+1/, '').replace(/\D/g, '')
      
      const { data: org } = await supabase
        .from('organizations').select('id')
        .order('created_at', { ascending: true }).limit(1).single()
      orgId = org?.id || null

      if (orgId) {
        const { data: lead } = await supabase
          .from('leads').select('id')
          .eq('organization_id', orgId)
          .or(`phone.eq.${phone},phone.eq.${normalized},phone_formatted.eq.${phone},phone_formatted.eq.+1${normalized}`)
          .limit(1).single()
        leadId = lead?.id || null
      }

      if (orgId && leadId) {
        const { data: conv } = await supabase
          .from('conversations').select('id')
          .eq('lead_id', leadId)
          .order('created_at', { ascending: false }).limit(1).single()
        conversationId = conv?.id || null
      }
    }

    // 4. Process if we found lead
    let processResult = 'skipped — no lead/org found'
    if (leadId && orgId) {
      try {
        await processEncounter({
          channel: 'voice',
          orgId,
          leadId,
          conversationId,
          transcript,
          summary: callAnalysis.call_summary || null,
          sentiment: callAnalysis.user_sentiment || null,
          callSuccessful: !!callAnalysis.call_successful,
          durationSeconds: callDuration,
          recordingUrl: callData.recording_url || '',
          retellCallId: callId,
          extractedInfo: extracted,
        })
        processResult = 'SUCCESS'
      } catch (e) {
        processResult = `ERROR: ${e instanceof Error ? e.message : String(e)}`
      }
    }

    return NextResponse.json({
      lead_found: { leadId, orgId, conversationId },
      extraction: extracted,
      call_meta: {
        duration: callDuration,
        sentiment: callAnalysis.user_sentiment,
        successful: callAnalysis.call_successful,
        summary: callAnalysis.call_summary,
      },
      process_result: processResult,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
