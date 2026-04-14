/**
 * Retell Events Webhook — Post-Call Processing
 *
 * When a call ends, Retell sends an event here. We:
 * 1. Fetch the full call data (transcript, analysis, recording)
 * 2. Extract caller information from the transcript (name, email, insurance)
 * 3. Update the lead with extracted info and a calculated score
 * 4. Log the full transcript into the conversation as messages
 * 5. Update the voice_call record with duration, recording, transcript
 */

import { NextRequest, NextResponse } from 'next/server'

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

// ── Extract structured info from transcript text ──
function extractCallerInfo(transcript: string): {
  firstName: string | null
  lastName: string | null
  email: string | null
  insurance: string | null
  appointmentBooked: boolean
  appointmentDetails: string | null
  concerns: string[]
  treatmentInterest: string[]
} {
  const result = {
    firstName: null as string | null,
    lastName: null as string | null,
    email: null as string | null,
    insurance: null as string | null,
    appointmentBooked: false,
    appointmentDetails: null as string | null,
    concerns: [] as string[],
    treatmentInterest: [] as string[],
  }

  // Extract name — look for "my name is X" pattern
  const nameMatch = transcript.match(/(?:my name is|name is|I'm|i am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i)
  if (nameMatch) {
    const parts = nameMatch[1].trim().split(/\s+/)
    result.firstName = parts[0] || null
    result.lastName = parts.slice(1).join(' ') || null
  }

  // Extract email
  const emailMatch = transcript.match(/([a-zA-Z0-9_.+-]+\s*(?:at|@)\s*[a-zA-Z0-9-]+\s*(?:dot|\.)\s*(?:com|net|org|edu|io|co))/i)
  if (emailMatch) {
    result.email = emailMatch[1]
      .replace(/\s*at\s*/gi, '@')
      .replace(/\s*dot\s*/gi, '.')
      .replace(/\s+/g, '')
      .toLowerCase()
  }

  // Extract insurance
  const insuranceMatch = transcript.match(/(?:insurance|have|got)\s+(?:is\s+)?(?:I have\s+)?(Delta Dental|Aetna|Cigna|MetLife|United|Guardian|Humana|Kaiser|Blue Cross|Anthem|PPO|HMO)/i)
  if (insuranceMatch) {
    result.insurance = insuranceMatch[1]
  }
  // Also check for insurance mentions more broadly
  const insuranceMentions = transcript.match(/(Delta Dental|Kaiser|Aetna|Cigna|MetLife|United Healthcare|Guardian|Humana|Blue Cross|Blue Shield|Anthem)/gi)
  if (insuranceMentions) {
    result.insurance = [...new Set(insuranceMentions)].join(', ')
  }

  // Check if appointment was booked
  const appointmentPhrases = [
    /scheduled for/i, /booked for/i, /all set for/i,
    /have you down for/i, /appointment.*(?:tuesday|wednesday|thursday|friday|monday|saturday)/i,
    /see you (?:this|next|on)/i, /looking forward to seeing you/i,
  ]
  result.appointmentBooked = appointmentPhrases.some(p => p.test(transcript))

  // Extract appointment details
  const apptMatch = transcript.match(/(?:scheduled|booked|set|down) for\s+(.*?)(?:\.|!|\?|$)/i)
  if (apptMatch) {
    result.appointmentDetails = apptMatch[1].trim().slice(0, 200)
  }

  // Extract concerns
  const concernPatterns: [RegExp, string][] = [
    [/missing teeth/i, 'Missing teeth'],
    [/pain|hurts|hurt|aching/i, 'Dental pain'],
    [/embarrass|confident|confidence|self.?conscious/i, 'Confidence/appearance'],
    [/eating|chewing|bite/i, 'Difficulty eating'],
    [/dentures?/i, 'Currently has dentures'],
    [/sleep apnea/i, 'Sleep apnea'],
    [/tmj|jaw pain/i, 'TMJ/Jaw issues'],
    [/expensive|cost|afford|price/i, 'Cost concerns'],
    [/scared|nervous|afraid|fear/i, 'Dental anxiety'],
    [/bone.?graft/i, 'Bone grafting questions'],
  ]
  for (const [pattern, label] of concernPatterns) {
    if (pattern.test(transcript)) {
      result.concerns.push(label)
    }
  }

  // Extract treatment interest
  const treatmentPatterns: [RegExp, string][] = [
    [/all.?on.?4|all on four/i, 'All-on-4'],
    [/all.?on.?6|all on six/i, 'All-on-6'],
    [/all.?on.?x/i, 'All-on-X'],
    [/single implant/i, 'Single implant'],
    [/full mouth/i, 'Full mouth rehabilitation'],
    [/implant/i, 'Dental implants'],
    [/financing|payment plan/i, 'Financing interested'],
    [/sleep apnea/i, 'Sleep apnea treatment'],
    [/orthodont/i, 'Orthodontics'],
  ]
  for (const [pattern, label] of treatmentPatterns) {
    if (pattern.test(transcript)) {
      result.treatmentInterest.push(label)
    }
  }

  return result
}

// ── Calculate lead score based on call analysis ──
function calculateLeadScore(
  callAnalysis: { call_successful?: boolean; user_sentiment?: string },
  callerInfo: ReturnType<typeof extractCallerInfo>,
  callDurationSeconds: number
): number {
  let score = 30 // Base score for calling in

  // Call duration scoring
  if (callDurationSeconds > 300) score += 20       // 5+ min = very engaged
  else if (callDurationSeconds > 120) score += 15  // 2+ min = engaged
  else if (callDurationSeconds > 60) score += 10   // 1+ min = somewhat engaged
  else if (callDurationSeconds > 30) score += 5    // 30s+ = brief

  // Sentiment scoring
  if (callAnalysis.user_sentiment === 'Positive') score += 15
  else if (callAnalysis.user_sentiment === 'Neutral') score += 5
  else if (callAnalysis.user_sentiment === 'Negative') score -= 10

  // Appointment booked = high intent
  if (callerInfo.appointmentBooked) score += 20

  // Insurance info provided = serious buyer
  if (callerInfo.insurance) score += 5

  // Email provided = engaged
  if (callerInfo.email) score += 5

  // Concerns = they've been thinking about it
  if (callerInfo.concerns.length >= 3) score += 5

  // Treatment interest specifics
  if (callerInfo.treatmentInterest.includes('Financing interested')) score += 5

  // Call outcome
  if (callAnalysis.call_successful) score += 5

  return Math.min(100, Math.max(0, score))
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

  // Only process call_ended and call_analyzed events
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
      console.error('[Voice Events] Failed to fetch call from Retell:', retellRes.status)
      return NextResponse.json({ received: true })
    }

    const callData = await retellRes.json()
    const transcript = (callData.transcript || '') as string
    const recordingUrl = (callData.recording_url || '') as string
    const callAnalysis = (callData.call_analysis || {}) as Record<string, unknown>
    const callDuration = (callData.call_cost?.total_duration_seconds || 0) as number
    const callMetadata = (callData.metadata || {}) as Record<string, unknown>
    const disconnectionReason = (callData.disconnection_reason || '') as string

    let leadId = callMetadata.lead_id as string | null
    let orgId = callMetadata.organization_id as string | null
    let conversationId = callMetadata.conversation_id as string | null

    // Fallback: if metadata is missing, look up by phone number
    if ((!leadId || !orgId) && callData.from_number) {
      const callerPhone = callData.from_number as string
      const normalizedPhone = callerPhone.replace(/^\+1/, '').replace(/\D/g, '')
      const phoneVariants = [
        callerPhone,
        normalizedPhone,
        `+1${normalizedPhone}`,
      ]

      // Find org first
      if (!orgId) {
        const { data: firstOrg } = await supabase
          .from('organizations')
          .select('id')
          .order('created_at', { ascending: true })
          .limit(1)
          .single()
        orgId = firstOrg?.id || null
      }

      // Find lead by phone
      if (orgId && !leadId) {
        const { data: phoneLead } = await supabase
          .from('leads')
          .select('id')
          .eq('organization_id', orgId)
          .or([
            ...phoneVariants.map(p => `phone.eq.${p}`),
            ...phoneVariants.map(p => `phone_formatted.eq.${p}`),
          ].join(','))
          .limit(1)
          .single()
        leadId = phoneLead?.id || null

        if (leadId) {
          console.log(`[Voice Events] Found lead by phone fallback: ${leadId}`)
        }
      }

      // Find conversation
      if (orgId && leadId && !conversationId) {
        const { data: conv } = await supabase
          .from('conversations')
          .select('id')
          .eq('organization_id', orgId)
          .eq('lead_id', leadId)
          .order('created_at', { ascending: false })
          .limit(1)
          .single()
        conversationId = conv?.id || null
      }
    }

    if (!transcript || !leadId || !orgId) {
      console.log('[Voice Events] No transcript/lead/org — skipping', { leadId, orgId, hasTranscript: !!transcript })
      return NextResponse.json({ received: true })
    }

    console.log(`[Voice Events] Processing call for lead ${leadId}, ${callDuration}s, ${transcript.length} chars`)

    // ── 2. Extract caller info from transcript ──
    const callerInfo = extractCallerInfo(transcript)
    console.log('[Voice Events] Extracted:', JSON.stringify({
      name: `${callerInfo.firstName} ${callerInfo.lastName}`,
      email: callerInfo.email,
      insurance: callerInfo.insurance,
      booked: callerInfo.appointmentBooked,
      concerns: callerInfo.concerns.length,
    }))

    // ── 3. Calculate lead score ──
    const leadScore = calculateLeadScore(
      callAnalysis as { call_successful?: boolean; user_sentiment?: string },
      callerInfo,
      callDuration
    )

    // ── 4. Update lead with extracted info ──
    const leadUpdate: Record<string, unknown> = {
      ai_score: leadScore,
      last_contacted_at: new Date().toISOString(),
    }

    // Update name if we extracted it and current name is default
    if (callerInfo.firstName) {
      const { data: currentLead } = await supabase
        .from('leads')
        .select('first_name, last_name')
        .eq('id', leadId)
        .single()

      if (currentLead && (
        currentLead.first_name === 'Unknown' ||
        currentLead.first_name?.startsWith('Caller') ||
        !currentLead.first_name
      )) {
        leadUpdate.first_name = callerInfo.firstName
        if (callerInfo.lastName) leadUpdate.last_name = callerInfo.lastName
      }
    }

    if (callerInfo.email) leadUpdate.email = callerInfo.email

    // Update status based on outcome
    if (callerInfo.appointmentBooked) {
      leadUpdate.status = 'qualified'
    } else if (callDuration > 60) {
      leadUpdate.status = 'contacted'
    }

    // Build comprehensive notes
    const noteLines: string[] = []
    noteLines.push(`📞 Voice call: ${Math.floor(callDuration / 60)}m ${callDuration % 60}s`)
    if (callAnalysis.call_summary) noteLines.push(`Summary: ${callAnalysis.call_summary}`)
    if (callAnalysis.user_sentiment) noteLines.push(`Sentiment: ${callAnalysis.user_sentiment}`)
    if (callerInfo.insurance) noteLines.push(`Insurance: ${callerInfo.insurance}`)
    if (callerInfo.appointmentBooked) noteLines.push(`✅ Appointment booked: ${callerInfo.appointmentDetails || 'details in transcript'}`)
    if (callerInfo.concerns.length) noteLines.push(`Concerns: ${callerInfo.concerns.join(', ')}`)
    if (callerInfo.treatmentInterest.length) noteLines.push(`Interested in: ${callerInfo.treatmentInterest.join(', ')}`)

    // Append to existing notes
    const { data: existingLead } = await supabase
      .from('leads')
      .select('notes')
      .eq('id', leadId)
      .single()

    const existingNotes = (existingLead?.notes || '').trim()
    const callNote = `\n\n--- Call ${new Date().toLocaleString()} ---\n${noteLines.join('\n')}`
    leadUpdate.notes = (existingNotes + callNote).slice(0, 5000)

    await supabase.from('leads').update(leadUpdate).eq('id', leadId)
    console.log(`[Voice Events] Lead ${leadId} updated: score=${leadScore}, status=${leadUpdate.status}`)

    // ── 5. Log transcript as messages in the conversation ──
    if (conversationId) {
      // Parse transcript into individual messages
      const lines = transcript.split('\n').filter(l => l.trim())
      const messages: Record<string, unknown>[] = []

      for (const line of lines) {
        const agentMatch = line.match(/^Agent:\s*(.+)/i)
        const userMatch = line.match(/^User:\s*(.+)/i)

        if (agentMatch) {
          messages.push({
            organization_id: orgId,
            conversation_id: conversationId,
            lead_id: leadId,
            direction: 'outbound',
            channel: 'voice',
            body: agentMatch[1].trim(),
            sender_type: 'ai',
            sender_name: 'Adrian (AI)',
            status: 'delivered',
            ai_generated: true,
            ai_model: 'retell-claude-4.5-sonnet',
            metadata: { retell_call_id: retellCallId, type: 'voice_transcript' },
          })
        } else if (userMatch) {
          messages.push({
            organization_id: orgId,
            conversation_id: conversationId,
            lead_id: leadId,
            direction: 'inbound',
            channel: 'voice',
            body: userMatch[1].trim(),
            sender_type: 'lead',
            status: 'delivered',
            metadata: { retell_call_id: retellCallId, type: 'voice_transcript' },
          })
        }
      }

      // Add a summary message at the end
      messages.push({
        organization_id: orgId,
        conversation_id: conversationId,
        lead_id: leadId,
        direction: 'outbound',
        channel: 'voice',
        body: `📊 Call Summary (${Math.floor(callDuration / 60)}m ${callDuration % 60}s)\n${noteLines.join('\n')}${recordingUrl ? `\n🔊 Recording: ${recordingUrl}` : ''}`,
        sender_type: 'system',
        sender_name: 'Call Analysis',
        status: 'delivered',
        ai_generated: true,
        metadata: {
          retell_call_id: retellCallId,
          type: 'voice_call_summary',
          ai_score: leadScore,
          appointment_booked: callerInfo.appointmentBooked,
          recording_url: recordingUrl,
          call_analysis: callAnalysis,
        },
      })

      if (messages.length > 0) {
        const { error: msgErr } = await supabase.from('messages').insert(messages)
        if (msgErr) console.error('[Voice Events] Failed to insert messages:', msgErr)
        else console.log(`[Voice Events] Logged ${messages.length} messages to conversation ${conversationId}`)
      }

      // Update conversation last_message_at
      await supabase
        .from('conversations')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', conversationId)
    }

    // ── 6. Update voice_call record ──
    const { data: existingCall } = await supabase
      .from('voice_calls')
      .select('id')
      .eq('retell_call_id', retellCallId)
      .single()

    if (existingCall) {
      await supabase.from('voice_calls').update({
        status: 'completed',
        ended_at: new Date().toISOString(),
        duration_seconds: callDuration,
        recording_url: recordingUrl,
        transcript: transcript.slice(0, 50000),
        transcript_summary: (callAnalysis.call_summary as string) || null,
        outcome: callerInfo.appointmentBooked ? 'appointment_booked' : (callAnalysis.call_successful ? 'interested' : disconnectionReason),
        lead_score_after: leadScore,
        sentiment: (callAnalysis.user_sentiment as string) || null,
        metadata: {
          ...callMetadata,
          call_analysis: callAnalysis,
          extracted_info: callerInfo,
          disconnection_reason: disconnectionReason,
        },
      }).eq('id', existingCall.id)
      console.log(`[Voice Events] voice_call ${existingCall.id} updated`)
    }

  } catch (error) {
    console.error('[Voice Events] Processing error:', error)
  }

  return NextResponse.json({ received: true })
}
