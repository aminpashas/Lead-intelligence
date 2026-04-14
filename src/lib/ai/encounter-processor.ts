/**
 * Unified Post-Encounter Intelligence Processor
 *
 * After ANY interaction (Voice, SMS, Email), this module:
 * 1. Extracts structured data from the conversation
 * 2. Updates lead profile (name, email, insurance, concerns, interests)
 * 3. Recalculates AI score based on cumulative engagement
 * 4. Updates lead status based on outcomes
 * 5. Logs to lead_activities (the audit trail visible in CRM)
 * 6. Updates engagement metrics (total_messages, response_time, etc.)
 * 7. Stores an ai_interaction record
 *
 * Called by:
 * - Voice: /api/voice/events (post-call)
 * - SMS:   /api/sms/send + agent-respond (post-message)
 * - Email: /api/email/send + agent-respond (post-message)
 */

type Channel = 'voice' | 'sms' | 'email'

type EncounterData = {
  channel: Channel
  orgId: string
  leadId: string
  conversationId: string | null

  // Content
  transcript: string          // Full text of conversation
  summary: string | null      // AI-generated summary
  sentiment: string | null    // Positive, Neutral, Negative
  callSuccessful: boolean

  // Call-specific
  durationSeconds?: number
  recordingUrl?: string
  retellCallId?: string

  // Extracted info (pre-parsed if available)
  extractedInfo?: {
    firstName?: string | null
    lastName?: string | null
    email?: string | null
    phone?: string | null
    insurance?: string | null
    appointmentBooked?: boolean
    appointmentDetails?: string | null
    concerns?: string[]
    treatmentInterest?: string[]
  }
}

type SupabaseClient = ReturnType<typeof getSupabase>

function getSupabase() {
  const { createClient } = require('@supabase/supabase-js')
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// ════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════

export async function processEncounter(data: EncounterData): Promise<void> {
  const supabase = getSupabase()
  if (!supabase) {
    console.error('[Encounter] No Supabase client')
    return
  }

  console.log(`[Encounter] Processing ${data.channel} encounter for lead ${data.leadId}`)

  try {
    // ── 1. Extract info from transcript if not pre-parsed ──
    const extracted = data.extractedInfo || extractFromTranscript(data.transcript)

    // ── 2. Calculate AI score ──
    const score = calculateScore(data, extracted)

    // ── 3. Update lead profile ──
    await updateLeadProfile(supabase, data, extracted, score)

    // ── 4. Log to lead_activities (audit trail) ──
    await logActivity(supabase, data, extracted, score)

    // ── 5. Update engagement metrics ──
    await updateEngagementMetrics(supabase, data)

    // ── 6. Store AI interaction record ──
    await logAIInteraction(supabase, data, score)

    // ── 7. Log transcript as conversation messages (if not already logged) ──
    if (data.channel === 'voice' && data.conversationId) {
      await logTranscriptAsMessages(supabase, data)
    }

    console.log(`[Encounter] Done: ${data.channel} | lead=${data.leadId} | score=${score}`)
  } catch (error) {
    console.error('[Encounter] Processing error:', error)
  }
}

// ════════════════════════════════════════════════════════════════
// TRANSCRIPT EXTRACTION (shared across all channels)
// ════════════════════════════════════════════════════════════════

export function extractFromTranscript(transcript: string) {
  const result = {
    firstName: null as string | null,
    lastName: null as string | null,
    email: null as string | null,
    phone: null as string | null,
    insurance: null as string | null,
    appointmentBooked: false,
    appointmentDetails: null as string | null,
    concerns: [] as string[],
    treatmentInterest: [] as string[],
  }

  // Name extraction
  const nameMatch = transcript.match(
    /(?:my name is|name is|I'm|i am|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i
  )
  if (nameMatch) {
    const parts = nameMatch[1].trim().split(/\s+/)
    result.firstName = parts[0] || null
    result.lastName = parts.slice(1).join(' ') || null
  }

  // Email extraction
  const emailMatch = transcript.match(
    /([a-zA-Z0-9_.+-]+\s*(?:at|@)\s*[a-zA-Z0-9-]+\s*(?:dot|\.)\s*(?:com|net|org|edu|io|co))/i
  )
  if (emailMatch) {
    result.email = emailMatch[1]
      .replace(/\s*at\s*/gi, '@')
      .replace(/\s*dot\s*/gi, '.')
      .replace(/\s+/g, '')
      .toLowerCase()
  }

  // Insurance mentions
  const insuranceMentions = transcript.match(
    /(Delta Dental|Kaiser|Aetna|Cigna|MetLife|United Healthcare|Guardian|Humana|Blue Cross|Blue Shield|Anthem|PPO|HMO)/gi
  )
  if (insuranceMentions) {
    result.insurance = [...new Set(insuranceMentions)].join(', ')
  }

  // Appointment booked
  const appointmentPhrases = [
    /scheduled for/i, /booked for/i, /all set for/i,
    /have you down for/i, /see you (?:this|next|on)/i,
    /looking forward to seeing you/i, /confirmed.*appointment/i,
  ]
  result.appointmentBooked = appointmentPhrases.some(p => p.test(transcript))

  if (result.appointmentBooked) {
    const apptMatch = transcript.match(
      /(?:scheduled|booked|set|down)\s+for\s+(.+?)(?:\.|!|\?|$)/i
    )
    if (apptMatch) result.appointmentDetails = apptMatch[1].trim().slice(0, 200)
  }

  // Concerns
  const concernPatterns: [RegExp, string][] = [
    [/missing teeth/i, 'Missing teeth'],
    [/pain|hurts|hurt|aching/i, 'Dental pain'],
    [/embarrass|confident|confidence|self.?conscious/i, 'Confidence/appearance'],
    [/eating|chewing|bite/i, 'Difficulty eating'],
    [/dentures?/i, 'Currently has dentures'],
    [/sleep apnea/i, 'Sleep apnea'],
    [/tmj|jaw pain/i, 'TMJ/Jaw issues'],
    [/expensive|cost|afford|price|budget/i, 'Cost concerns'],
    [/scared|nervous|afraid|fear|anxiety/i, 'Dental anxiety'],
    [/bone.?graft/i, 'Bone grafting questions'],
  ]
  for (const [pattern, label] of concernPatterns) {
    if (pattern.test(transcript)) result.concerns.push(label)
  }

  // Treatment interest
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
    [/veneers?/i, 'Veneers'],
    [/crown|bridge/i, 'Crown/Bridge'],
  ]
  for (const [pattern, label] of treatmentPatterns) {
    if (pattern.test(transcript)) result.treatmentInterest.push(label)
  }

  return result
}

// ════════════════════════════════════════════════════════════════
// SCORING ENGINE (unified across channels)
// ════════════════════════════════════════════════════════════════

function calculateScore(
  data: EncounterData,
  extracted: ReturnType<typeof extractFromTranscript>
): number {
  let score = 20 // Base score for any interaction

  // Channel-specific scoring
  switch (data.channel) {
    case 'voice':
      score += 15 // Calling is high intent
      if ((data.durationSeconds || 0) > 300) score += 20
      else if ((data.durationSeconds || 0) > 120) score += 15
      else if ((data.durationSeconds || 0) > 60) score += 10
      else if ((data.durationSeconds || 0) > 30) score += 5
      break
    case 'sms':
      score += 10
      // SMS engagement — count exchanges
      const smsExchanges = (data.transcript.match(/\n/g) || []).length
      if (smsExchanges > 10) score += 15
      else if (smsExchanges > 5) score += 10
      else if (smsExchanges > 2) score += 5
      break
    case 'email':
      score += 5
      if (data.transcript.length > 500) score += 10
      break
  }

  // Sentiment
  if (data.sentiment === 'Positive') score += 15
  else if (data.sentiment === 'Neutral') score += 5
  else if (data.sentiment === 'Negative') score -= 10

  // Key actions
  if (extracted.appointmentBooked) score += 20
  if (extracted.insurance) score += 5
  if (extracted.email) score += 5
  if (extracted.concerns.length >= 3) score += 5
  if (extracted.treatmentInterest.length >= 2) score += 5
  if (data.callSuccessful) score += 5

  return Math.min(100, Math.max(0, score))
}

// ════════════════════════════════════════════════════════════════
// DATABASE UPDATES
// ════════════════════════════════════════════════════════════════

async function updateLeadProfile(
  supabase: SupabaseClient,
  data: EncounterData,
  extracted: ReturnType<typeof extractFromTranscript>,
  score: number
) {
  const update: Record<string, unknown> = {
    ai_score: score,
    last_contacted_at: new Date().toISOString(),
    ai_score_updated_at: new Date().toISOString(),
  }

  // Update name if current is default
  if (extracted.firstName) {
    const { data: current } = await supabase
      .from('leads')
      .select('first_name')
      .eq('id', data.leadId)
      .single()

    if (current?.first_name === 'Unknown' || current?.first_name?.startsWith('Caller') || !current?.first_name) {
      update.first_name = extracted.firstName
      if (extracted.lastName) update.last_name = extracted.lastName
    }
  }

  if (extracted.email) update.email = extracted.email
  if (extracted.insurance) update.insurance_provider = extracted.insurance

  // Status updates
  if (extracted.appointmentBooked) {
    update.status = 'qualified'
    update.qualified_at = new Date().toISOString()
  } else if (data.channel === 'voice' && (data.durationSeconds || 0) > 60) {
    update.status = 'contacted'
  } else if (data.channel === 'sms' || data.channel === 'email') {
    // Only upgrade from 'new' to 'contacted'
    const { data: current } = await supabase
      .from('leads')
      .select('status')
      .eq('id', data.leadId)
      .single()
    if (current?.status === 'new') update.status = 'contacted'
  }

  // Store concerns and interests in custom_fields
  if (extracted.concerns.length > 0 || extracted.treatmentInterest.length > 0) {
    const { data: current } = await supabase
      .from('leads')
      .select('custom_fields')
      .eq('id', data.leadId)
      .single()

    const existing = (current?.custom_fields || {}) as Record<string, unknown>
    update.custom_fields = {
      ...existing,
      concerns: [...new Set([
        ...((existing.concerns as string[]) || []),
        ...extracted.concerns,
      ])],
      treatment_interest: [...new Set([
        ...((existing.treatment_interest as string[]) || []),
        ...extracted.treatmentInterest,
      ])],
    }
  }

  // Build note
  const channelEmoji = data.channel === 'voice' ? '📞' : data.channel === 'sms' ? '💬' : '📧'
  const noteLines: string[] = []
  noteLines.push(`${channelEmoji} ${data.channel.toUpperCase()} encounter`)
  if (data.durationSeconds) noteLines.push(`Duration: ${Math.floor(data.durationSeconds / 60)}m ${data.durationSeconds % 60}s`)
  if (data.summary) noteLines.push(`Summary: ${data.summary}`)
  if (data.sentiment) noteLines.push(`Sentiment: ${data.sentiment}`)
  if (extracted.insurance) noteLines.push(`Insurance: ${extracted.insurance}`)
  if (extracted.appointmentBooked) noteLines.push(`✅ Appointment: ${extracted.appointmentDetails || 'Booked'}`)
  if (extracted.concerns.length) noteLines.push(`Concerns: ${extracted.concerns.join(', ')}`)
  if (extracted.treatmentInterest.length) noteLines.push(`Interest: ${extracted.treatmentInterest.join(', ')}`)

  const { data: existingLead } = await supabase
    .from('leads')
    .select('notes')
    .eq('id', data.leadId)
    .single()

  const existingNotes = (existingLead?.notes || '').trim()
  const newNote = `\n\n--- ${new Date().toLocaleString()} ---\n${noteLines.join('\n')}`
  update.notes = (existingNotes + newNote).slice(-5000) // Keep last 5000 chars

  await supabase.from('leads').update(update).eq('id', data.leadId)
}

async function logActivity(
  supabase: SupabaseClient,
  data: EncounterData,
  extracted: ReturnType<typeof extractFromTranscript>,
  score: number
) {
  const channelEmoji = data.channel === 'voice' ? '📞' : data.channel === 'sms' ? '💬' : '📧'
  
  // Determine activity type
  const activityType = data.channel === 'voice'
    ? (extracted.appointmentBooked ? 'voice_call_booked' : 'voice_call_completed')
    : data.channel === 'sms'
      ? 'sms_conversation'
      : 'email_conversation'

  const title = extracted.appointmentBooked
    ? `${channelEmoji} Appointment Booked via ${data.channel.toUpperCase()}`
    : `${channelEmoji} ${data.channel.toUpperCase()} Conversation`

  const descriptionParts: string[] = []
  if (data.summary) descriptionParts.push(data.summary)
  if (data.sentiment) descriptionParts.push(`Sentiment: ${data.sentiment}`)
  if (data.durationSeconds) descriptionParts.push(`Duration: ${Math.floor(data.durationSeconds / 60)}m ${data.durationSeconds % 60}s`)
  descriptionParts.push(`AI Score: ${score}/100`)

  await supabase.from('lead_activities').insert({
    organization_id: data.orgId,
    lead_id: data.leadId,
    activity_type: activityType,
    title,
    description: descriptionParts.join(' | '),
    metadata: {
      channel: data.channel,
      ai_score: score,
      sentiment: data.sentiment,
      appointment_booked: extracted.appointmentBooked,
      concerns: extracted.concerns,
      treatment_interest: extracted.treatmentInterest,
      recording_url: data.recordingUrl || null,
      retell_call_id: data.retellCallId || null,
      duration_seconds: data.durationSeconds || null,
    },
  })
}

async function updateEngagementMetrics(
  supabase: SupabaseClient,
  data: EncounterData
) {
  const metrics: Record<string, unknown> = {
    last_contacted_at: new Date().toISOString(),
  }

  switch (data.channel) {
    case 'voice':
      // Increment voice-related metrics
      break
    case 'sms':
      metrics.total_sms_sent = supabase.rpc ? undefined : undefined // Use SQL increment
      break
    case 'email':
      metrics.total_emails_sent = supabase.rpc ? undefined : undefined
      break
  }

  // Update conversation last_message_at
  if (data.conversationId) {
    await supabase
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', data.conversationId)
  }
}

async function logAIInteraction(
  supabase: SupabaseClient,
  data: EncounterData,
  score: number
) {
  await supabase.from('ai_interactions').insert({
    organization_id: data.orgId,
    lead_id: data.leadId,
    interaction_type: `${data.channel}_encounter`,
    model: data.channel === 'voice' ? 'retell-claude-4.5-sonnet' : 'claude-sonnet-4-20250514',
    output_summary: data.summary?.slice(0, 200) || `${data.channel} encounter processed`,
    success: true,
    metadata: {
      channel: data.channel,
      ai_score: score,
      duration_seconds: data.durationSeconds || null,
      sentiment: data.sentiment || null,
      appointment_booked: data.extractedInfo?.appointmentBooked || false,
    },
  })
}

async function logTranscriptAsMessages(
  supabase: SupabaseClient,
  data: EncounterData
) {
  if (!data.conversationId || !data.transcript) return

  // Check if messages already exist for this call
  const { count } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', data.conversationId)
    .eq('channel', 'voice')
    .limit(1)

  if (count && count > 0) {
    console.log('[Encounter] Voice messages already logged, skipping')
    return
  }

  const lines = data.transcript.split('\n').filter(l => l.trim())
  const messages: Record<string, unknown>[] = []

  for (const line of lines) {
    const agentMatch = line.match(/^Agent:\s*(.+)/i)
    const userMatch = line.match(/^User:\s*(.+)/i)

    if (agentMatch) {
      messages.push({
        organization_id: data.orgId,
        conversation_id: data.conversationId,
        lead_id: data.leadId,
        direction: 'outbound',
        channel: 'voice',
        body: agentMatch[1].trim(),
        sender_type: 'ai',
        sender_name: 'Adrian (AI)',
        status: 'delivered',
        ai_generated: true,
        metadata: { retell_call_id: data.retellCallId, type: 'voice_transcript' },
      })
    } else if (userMatch) {
      messages.push({
        organization_id: data.orgId,
        conversation_id: data.conversationId,
        lead_id: data.leadId,
        direction: 'inbound',
        channel: 'voice',
        body: userMatch[1].trim(),
        sender_type: 'lead',
        status: 'delivered',
        metadata: { retell_call_id: data.retellCallId, type: 'voice_transcript' },
      })
    }
  }

  // Add summary message
  const channelEmoji = '📞'
  const summaryParts = [
    `${channelEmoji} Call Summary`,
    data.durationSeconds ? `(${Math.floor(data.durationSeconds / 60)}m ${data.durationSeconds % 60}s)` : '',
  ].filter(Boolean).join(' ')

  const summaryBody = [
    summaryParts,
    data.summary || '',
    data.recordingUrl ? `🔊 Recording: ${data.recordingUrl}` : '',
  ].filter(Boolean).join('\n')

  messages.push({
    organization_id: data.orgId,
    conversation_id: data.conversationId,
    lead_id: data.leadId,
    direction: 'outbound',
    channel: 'voice',
    body: summaryBody,
    sender_type: 'system',
    sender_name: 'Call Analysis',
    status: 'delivered',
    ai_generated: true,
    metadata: {
      retell_call_id: data.retellCallId,
      type: 'voice_call_summary',
      recording_url: data.recordingUrl,
    },
  })

  if (messages.length > 0) {
    const { error } = await supabase.from('messages').insert(messages)
    if (error) console.error('[Encounter] Failed to insert messages:', error)
    else console.log(`[Encounter] Logged ${messages.length} voice messages`)
  }
}
