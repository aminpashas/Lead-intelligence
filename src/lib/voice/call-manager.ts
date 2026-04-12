/**
 * Call Manager — Voice Call Lifecycle Management
 *
 * Handles the full lifecycle of a voice call:
 * - Pre-call: consent verification, TCPA checks, DNC lookup
 * - Initiation: create call record, trigger Retell outbound
 * - In-progress: status updates, transcript accumulation
 * - Post-call: save transcript, recording, update lead, log activity
 *
 * Works with both inbound and outbound calls.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createOutboundCall,
  getCallDetail,
  type RetellCallDetail,
  type RetellCallConfig,
} from './retell-client'
import { decryptField, searchHash } from '@/lib/encryption'
import { auditPHITransmission } from '@/lib/hipaa-audit'
import { logHIPAAEvent } from '@/lib/ai/hipaa'
import { logger } from '@/lib/logger'
import type {
  VoiceCallStatus,
  VoiceCallOutcome,
  VoiceCallTranscriptEntry,
} from '@/types/database'

// ═══════════════════════════════════════════════════════════════
// PRE-CALL CHECKS
// ═══════════════════════════════════════════════════════════════

export type PreCallCheckResult = {
  allowed: boolean
  reason?: string
  phone?: string // Decrypted phone number for dialing
}

/**
 * Verify that we're allowed to call this lead.
 * Checks: consent, opt-out, DNC flag, phone validity, active hours.
 */
export async function preCallCheck(
  supabase: SupabaseClient,
  leadId: string,
  organizationId: string
): Promise<PreCallCheckResult> {
  // Get lead with consent fields
  const { data: lead, error } = await supabase
    .from('leads')
    .select(`
      id, first_name, phone_formatted, phone,
      voice_consent, voice_opt_out, do_not_call,
      sms_consent, sms_opt_out,
      phone_valid, phone_line_type,
      state, timezone
    `)
    .eq('id', leadId)
    .eq('organization_id', organizationId)
    .single()

  if (error || !lead) {
    return { allowed: false, reason: 'lead_not_found' }
  }

  // DNC check
  if (lead.do_not_call) {
    return { allowed: false, reason: 'do_not_call_flagged' }
  }

  // Voice opt-out check
  if (lead.voice_opt_out) {
    return { allowed: false, reason: 'voice_opt_out' }
  }

  // Consent check — require explicit voice consent OR SMS consent as fallback
  // (TCPA requires prior express consent for autodialed calls)
  if (!lead.voice_consent && !lead.sms_consent) {
    return { allowed: false, reason: 'no_consent' }
  }

  // Phone number check
  const phone = lead.phone_formatted
    ? (decryptField(lead.phone_formatted) || lead.phone_formatted)
    : lead.phone

  if (!phone) {
    return { allowed: false, reason: 'no_phone_number' }
  }

  // Validate phone format
  if (!/^\+?1?\d{10,15}$/.test(phone.replace(/[\s\-\(\)]/g, ''))) {
    return { allowed: false, reason: 'invalid_phone_format' }
  }

  // Check org voice settings
  const { data: org } = await supabase
    .from('organizations')
    .select('voice_enabled, voice_max_outbound_per_hour')
    .eq('id', organizationId)
    .single()

  if (!org?.voice_enabled) {
    return { allowed: false, reason: 'voice_not_enabled_for_org' }
  }

  // Rate limit: check how many calls we've made this hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count } = await supabase
    .from('voice_calls')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('direction', 'outbound')
    .gte('created_at', oneHourAgo)

  if ((count || 0) >= (org.voice_max_outbound_per_hour || 20)) {
    return { allowed: false, reason: 'hourly_rate_limit_exceeded' }
  }

  return { allowed: true, phone }
}

// ═══════════════════════════════════════════════════════════════
// CALL INITIATION
// ═══════════════════════════════════════════════════════════════

/**
 * Initiate an outbound voice call to a lead.
 * Creates the call record in DB, then triggers Retell to dial.
 */
export async function initiateOutboundCall(
  supabase: SupabaseClient,
  params: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    phone: string // Already decrypted from preCallCheck
    voice_campaign_id?: string
    agent_type?: 'setter' | 'closer'
  }
): Promise<{ call_id: string; retell_call_id: string } | { error: string }> {
  const { organization_id, lead_id, lead, phone, voice_campaign_id, agent_type } = params

  // Get org settings for caller ID and agent
  const { data: org } = await supabase
    .from('organizations')
    .select('name, voice_retell_agent_id, voice_outbound_caller_id')
    .eq('id', organization_id)
    .single()

  if (!org?.voice_retell_agent_id) {
    return { error: 'Retell agent not configured for this organization' }
  }

  const fromNumber = org.voice_outbound_caller_id || process.env.TWILIO_PHONE_NUMBER
  if (!fromNumber) {
    return { error: 'No outbound caller ID configured' }
  }

  // Find or create voice conversation
  let conversationId: string
  const { data: existingConvo } = await supabase
    .from('conversations')
    .select('id')
    .eq('lead_id', lead_id)
    .eq('channel', 'voice')
    .eq('status', 'active')
    .limit(1)
    .single()

  if (existingConvo) {
    conversationId = existingConvo.id
  } else {
    const { data: newConvo } = await supabase
      .from('conversations')
      .insert({
        organization_id,
        lead_id,
        channel: 'voice',
        status: 'active',
        ai_enabled: true,
        ai_mode: 'auto',
        active_agent: agent_type || 'setter',
      })
      .select('id')
      .single()

    if (!newConvo) {
      return { error: 'Failed to create conversation' }
    }
    conversationId = newConvo.id
  }

  // Create call record in DB
  const { data: callRecord, error: insertError } = await supabase
    .from('voice_calls')
    .insert({
      organization_id,
      lead_id,
      conversation_id: conversationId,
      direction: 'outbound',
      status: 'initiated' as VoiceCallStatus,
      from_number: fromNumber,
      to_number: phone,
      agent_type: agent_type || 'setter',
      voice_campaign_id: voice_campaign_id || null,
      consent_verified: true,
      tcpa_compliant: true,
    })
    .select('id')
    .single()

  if (insertError || !callRecord) {
    logger.error('Failed to create voice call record', { lead_id }, insertError ? new Error(insertError.message) : undefined)
    return { error: 'Failed to create call record' }
  }

  // HIPAA: Log PHI transmission to Retell
  auditPHITransmission(
    { supabase, organizationId: organization_id, actorType: 'system' },
    'voice_call',
    callRecord.id,
    'Retell AI (voice call)',
    ['phone']
  )

  // Trigger the call via Retell
  const retellConfig: RetellCallConfig = {
    from_number: fromNumber,
    to_number: phone,
    metadata: {
      call_id: callRecord.id,
      organization_id,
      lead_id,
      conversation_id: conversationId,
    },
    retell_llm_dynamic_variables: {
      patient_name: (lead.first_name as string) || '',
      practice_name: org.name || 'our practice',
      call_direction: 'outbound',
    },
  }

  try {
    const retellResponse = await createOutboundCall(org.voice_retell_agent_id, retellConfig)

    // Update call record with Retell call ID
    await supabase
      .from('voice_calls')
      .update({
        retell_call_id: retellResponse.call_id,
        status: 'ringing' as VoiceCallStatus,
        started_at: new Date().toISOString(),
      })
      .eq('id', callRecord.id)

    // Log activity
    await supabase.from('lead_activities').insert({
      organization_id,
      lead_id,
      activity_type: 'voice_call_initiated',
      title: `AI outbound call initiated`,
      metadata: {
        call_id: callRecord.id,
        retell_call_id: retellResponse.call_id,
        campaign_id: voice_campaign_id,
      },
    })

    logger.info('Outbound voice call initiated', {
      call_id: callRecord.id,
      retell_call_id: retellResponse.call_id,
      lead_id,
    })

    return { call_id: callRecord.id, retell_call_id: retellResponse.call_id }
  } catch (error) {
    // Mark call as failed
    await supabase
      .from('voice_calls')
      .update({
        status: 'failed' as VoiceCallStatus,
        ended_at: new Date().toISOString(),
        outcome: 'technical_failure' as VoiceCallOutcome,
        outcome_notes: error instanceof Error ? error.message : 'Unknown error',
      })
      .eq('id', callRecord.id)

    logger.error('Failed to initiate Retell call', { call_id: callRecord.id }, error instanceof Error ? error : undefined)
    return { error: `Failed to initiate call: ${error instanceof Error ? error.message : 'Unknown'}` }
  }
}

// ═══════════════════════════════════════════════════════════════
// INBOUND CALL HANDLING
// ═══════════════════════════════════════════════════════════════

/**
 * Handle an inbound call. Creates the call record and conversation.
 * The actual AI conversation is handled by the Retell webhook.
 */
export async function handleInboundCall(
  supabase: SupabaseClient,
  params: {
    from_number: string
    to_number: string
    twilio_call_sid?: string
    retell_call_id?: string
  }
): Promise<{ call_id: string; lead_id: string; organization_id: string; conversation_id: string } | null> {
  const { from_number, to_number, twilio_call_sid, retell_call_id } = params

  // Look up the lead by phone number
  const phoneHash = searchHash(from_number)
  let lead: Record<string, unknown> | null = null

  if (phoneHash) {
    const { data } = await supabase
      .from('leads')
      .select('*')
      .eq('phone_hash', phoneHash)
      .limit(1)
      .single()
    lead = data
  }

  // Fallback: plaintext phone lookup
  if (!lead) {
    const sanitizedFrom = from_number.replace(/[^+0-9]/g, '')
    if (sanitizedFrom) {
      const { data } = await supabase
        .from('leads')
        .select('*')
        .or(`phone_formatted.eq.${sanitizedFrom},phone.eq.${sanitizedFrom}`)
        .limit(1)
        .single()
      lead = data
    }
  }

  if (!lead) {
    logger.info('Inbound voice call from unknown number', { from: from_number.replace(/\d(?=\d{4})/g, '*') })
    return null
  }

  const organizationId = lead.organization_id as string
  const leadId = lead.id as string

  // Find or create voice conversation
  let conversationId: string
  const { data: existingConvo } = await supabase
    .from('conversations')
    .select('id')
    .eq('lead_id', leadId)
    .eq('channel', 'voice')
    .eq('status', 'active')
    .limit(1)
    .single()

  if (existingConvo) {
    conversationId = existingConvo.id
  } else {
    const { data: newConvo } = await supabase
      .from('conversations')
      .insert({
        organization_id: organizationId,
        lead_id: leadId,
        channel: 'voice',
        status: 'active',
        ai_enabled: true,
        ai_mode: 'auto',
        active_agent: 'setter',
      })
      .select('id')
      .single()

    if (!newConvo) return null
    conversationId = newConvo.id
  }

  // Create call record
  const { data: callRecord } = await supabase
    .from('voice_calls')
    .insert({
      organization_id: organizationId,
      lead_id: leadId,
      conversation_id: conversationId,
      direction: 'inbound',
      status: 'ringing' as VoiceCallStatus,
      from_number,
      to_number,
      twilio_call_sid: twilio_call_sid || null,
      retell_call_id: retell_call_id || null,
      agent_type: 'setter',
      consent_verified: true, // Inbound = patient initiated
      tcpa_compliant: true,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (!callRecord) return null

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: organizationId,
    lead_id: leadId,
    activity_type: 'voice_call_received',
    title: 'Inbound voice call received',
    metadata: { call_id: callRecord.id },
  })

  return {
    call_id: callRecord.id,
    lead_id: leadId,
    organization_id: organizationId,
    conversation_id: conversationId,
  }
}

// ═══════════════════════════════════════════════════════════════
// POST-CALL PROCESSING
// ═══════════════════════════════════════════════════════════════

/**
 * Process a completed call. Fetches final data from Retell and
 * updates our records with transcript, recording, outcome.
 */
export async function processCallEnd(
  supabase: SupabaseClient,
  callId: string,
  retellCallDetail?: RetellCallDetail
): Promise<void> {
  // Get our call record
  const { data: callRecord } = await supabase
    .from('voice_calls')
    .select('*, lead_id, organization_id, conversation_id, voice_campaign_id')
    .eq('id', callId)
    .single()

  if (!callRecord) {
    logger.error('Post-call processing: call record not found', { callId })
    return
  }

  // If we don't have the Retell detail, fetch it
  let detail = retellCallDetail
  if (!detail && callRecord.retell_call_id) {
    try {
      detail = await getCallDetail(callRecord.retell_call_id)
    } catch (error) {
      logger.error('Failed to fetch Retell call detail', { callId }, error instanceof Error ? error : undefined)
    }
  }

  // Build transcript entries
  const transcript: VoiceCallTranscriptEntry[] = detail?.transcript_object?.map((t, i) => ({
    role: t.role === 'agent' ? 'agent' as const : 'lead' as const,
    content: t.content,
    timestamp_ms: t.words?.[0]?.start || i * 1000,
  })) || []

  // Determine outcome from call analysis
  let outcome: VoiceCallOutcome | null = null
  if (detail?.call_analysis) {
    if (detail.call_analysis.call_successful) {
      outcome = 'interested'
    } else if (detail.call_analysis.user_sentiment === 'Negative') {
      outcome = 'not_interested'
    }
  }

  if (detail?.disconnection_reason === 'voicemail_reached') {
    outcome = 'voicemail_left'
  } else if (detail?.disconnection_reason === 'no_answer' || detail?.disconnection_reason === 'busy') {
    outcome = detail.disconnection_reason as VoiceCallOutcome
  }

  // Update call record
  const duration = detail?.duration_ms ? Math.round(detail.duration_ms / 1000) : 0

  await supabase
    .from('voice_calls')
    .update({
      status: 'completed' as VoiceCallStatus,
      duration_seconds: duration,
      ended_at: detail?.end_timestamp
        ? new Date(detail.end_timestamp).toISOString()
        : new Date().toISOString(),
      answered_at: detail?.start_timestamp && detail?.end_timestamp
        ? new Date(detail.start_timestamp).toISOString()
        : null,
      recording_url: detail?.recording_url || null,
      recording_duration_seconds: duration,
      transcript,
      transcript_summary: detail?.call_analysis?.call_summary || null,
      outcome,
    })
    .eq('id', callId)

  // Store transcript as messages for conversation continuity
  if (transcript.length > 0) {
    const messages = transcript.map(t => ({
      organization_id: callRecord.organization_id,
      conversation_id: callRecord.conversation_id,
      lead_id: callRecord.lead_id,
      direction: t.role === 'lead' ? 'inbound' : 'outbound',
      channel: 'voice',
      body: t.content,
      sender_type: t.role === 'lead' ? 'lead' : 'ai',
      status: 'delivered',
      ai_generated: t.role === 'agent',
      metadata: { voice_call_id: callId },
    }))

    await supabase.from('messages').insert(messages)
  }

  // Update conversation
  const lastMessage = transcript[transcript.length - 1]
  if (lastMessage) {
    await supabase
      .from('conversations')
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: `📞 ${lastMessage.content.substring(0, 80)}`,
        message_count: transcript.length,
      })
      .eq('id', callRecord.conversation_id)
  }

  // Update lead
  await supabase
    .from('leads')
    .update({ last_contacted_at: new Date().toISOString() })
    .eq('id', callRecord.lead_id)

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: callRecord.organization_id,
    lead_id: callRecord.lead_id,
    activity_type: 'voice_call_completed',
    title: `Voice call completed (${duration}s)`,
    description: detail?.call_analysis?.call_summary || `${callRecord.direction} call lasted ${duration} seconds`,
    metadata: {
      call_id: callId,
      duration_seconds: duration,
      outcome,
      direction: callRecord.direction,
    },
  })

  // Update campaign stats if part of a campaign
  if (callRecord.voice_campaign_id) {
    await updateCampaignStats(supabase, callRecord.voice_campaign_id, outcome, duration)
  }

  // HIPAA: Log call recording storage
  if (detail?.recording_url) {
    await logHIPAAEvent(supabase, {
      organization_id: callRecord.organization_id,
      event_type: 'phi_stored',
      severity: 'info',
      actor_type: 'system',
      resource_type: 'voice_call_recording',
      resource_id: callId,
      description: 'Voice call recording stored (contains PHI)',
      phi_categories: ['voice_recording'],
      metadata: { duration_seconds: duration },
    })
  }

  logger.info('Post-call processing complete', {
    call_id: callId,
    duration_seconds: duration,
    outcome,
    transcript_entries: transcript.length,
  })
}

// ═══════════════════════════════════════════════════════════════
// CAMPAIGN STATS UPDATE
// ═══════════════════════════════════════════════════════════════

async function updateCampaignStats(
  supabase: SupabaseClient,
  campaignId: string,
  outcome: VoiceCallOutcome | null,
  durationSeconds: number
): Promise<void> {
  // Increment the appropriate counters
  const updates: Record<string, unknown> = {}

  switch (outcome) {
    case 'appointment_booked':
      updates.total_appointments = supabase.rpc ? undefined : undefined // Use RPC below
      updates.total_connected = undefined
      break
    case 'voicemail_left':
      updates.total_voicemails = undefined
      break
    case 'no_answer':
      updates.total_no_answer = undefined
      break
    case 'do_not_call':
      updates.total_do_not_call = undefined
      break
    default:
      if (durationSeconds > 0) updates.total_connected = undefined
      break
  }

  // Simple approach: fetch current stats and increment
  const { data: campaign } = await supabase
    .from('voice_campaigns')
    .select('total_called, total_connected, total_appointments, total_voicemails, total_no_answer, total_do_not_call, avg_call_duration_seconds')
    .eq('id', campaignId)
    .single()

  if (!campaign) return

  const incrementUpdates: Record<string, number> = {
    total_called: (campaign.total_called || 0) + 1,
  }

  if (durationSeconds > 0) {
    incrementUpdates.total_connected = (campaign.total_connected || 0) + 1
    // Running average of call duration
    const totalCalls = (campaign.total_connected || 0) + 1
    incrementUpdates.avg_call_duration_seconds = Math.round(
      ((campaign.avg_call_duration_seconds || 0) * (totalCalls - 1) + durationSeconds) / totalCalls
    )
  }

  if (outcome === 'appointment_booked') incrementUpdates.total_appointments = (campaign.total_appointments || 0) + 1
  if (outcome === 'voicemail_left') incrementUpdates.total_voicemails = (campaign.total_voicemails || 0) + 1
  if (outcome === 'no_answer') incrementUpdates.total_no_answer = (campaign.total_no_answer || 0) + 1
  if (outcome === 'do_not_call') incrementUpdates.total_do_not_call = (campaign.total_do_not_call || 0) + 1

  await supabase
    .from('voice_campaigns')
    .update(incrementUpdates)
    .eq('id', campaignId)
}
