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
import { randomUUID } from 'crypto'
import {
  createOutboundCall,
  getCallDetail,
  type RetellCallDetail,
  type RetellCallConfig,
} from './retell-client'
import { decryptField, searchHash } from '@/lib/encryption'
import { checkSendWindow } from '@/lib/campaigns/send-window'
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

  // Cross-channel revocation: a prior SMS opt-out ("STOP") is a revocation of
  // automated contact and also blocks autodialed voice. This is defense-in-depth
  // alongside the STOP handler now setting voice_opt_out, and — critically — it
  // protects leads who opted out via SMS BEFORE that handler change (they still
  // have sms_opt_out=true / voice_opt_out=false and would otherwise be dialable).
  if (lead.sms_opt_out) {
    return { allowed: false, reason: 'sms_opt_out' }
  }

  // Consent check. TCPA requires prior express consent for autodialed calls, and
  // SMS consent is NOT a substitute for VOICE-autodial consent. Strict by default
  // (Phase 1.4): require explicit voice_consent. The legacy SMS fallback is only
  // honored when VOICE_ALLOW_SMS_CONSENT_FALLBACK is explicitly set, so loosening
  // the standard is a deliberate per-deployment switch rather than the default.
  const allowSmsFallback = process.env.VOICE_ALLOW_SMS_CONSENT_FALLBACK === 'true'
  const hasConsent = !!lead.voice_consent || (allowSmsFallback && !!lead.sms_consent)
  if (!hasConsent) {
    return { allowed: false, reason: 'no_consent' }
  }

  // TCPA calling window: no autodialed calls before 8am / after 9pm in the lead's
  // local time. Previously only the campaign dialer enforced this — manual and
  // speed-to-lead calls bypassed it. Centralized here so every outbound path is covered.
  const callWindow = checkSendWindow({
    start_hour: 8,
    end_hour: 21,
    timezone: lead.timezone || 'America/New_York',
    days: [0, 1, 2, 3, 4, 5, 6],
  })
  if (!callWindow.allowed) {
    return { allowed: false, reason: 'outside_calling_hours' }
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
// STAFF (HUMAN) CALL INTENT — browser softphone + ring-my-phone bridge
// ═══════════════════════════════════════════════════════════════

export type StaffCallIntent = {
  dialToken: string
  callId: string
  phone: string // decrypted lead number to dial
  fromNumber: string // org caller ID the lead sees
  recording: boolean
}

/**
 * Shared setup for a human-placed outbound call (browser or bridge). Runs the
 * compliance gate, resolves the org caller ID, and inserts a voice_calls row with
 * a one-time `dial_token`. Both /api/voice/prepare (browser) and /api/voice/bridge
 * (ring-my-phone) build on this so the gate and row shape never drift.
 *
 * Returns `{ error, status }` for a caller to surface as an HTTP response.
 */
export async function prepareStaffCallIntent(
  supabase: SupabaseClient,
  params: {
    organizationId: string
    leadId: string
    staffUserId: string
    callMode: 'browser' | 'bridge'
  }
): Promise<StaffCallIntent | { error: string; status: number }> {
  const check = await preCallCheck(supabase, params.leadId, params.organizationId)
  if (!check.allowed) {
    return { error: `Cannot call this lead: ${check.reason}`, status: 422 }
  }

  const { data: org } = await supabase
    .from('organizations')
    .select('voice_outbound_caller_id, voice_recording_enabled')
    .eq('id', params.organizationId)
    .single()

  const fromNumber = org?.voice_outbound_caller_id || process.env.TWILIO_PHONE_NUMBER
  if (!fromNumber) {
    return { error: 'No outbound caller ID configured', status: 422 }
  }

  const dialToken = randomUUID()
  const { data: callRecord, error } = await supabase
    .from('voice_calls')
    .insert({
      organization_id: params.organizationId,
      lead_id: params.leadId,
      direction: 'outbound',
      status: 'initiated',
      call_mode: params.callMode,
      agent_type: 'none',
      staff_user_id: params.staffUserId,
      from_number: fromNumber,
      to_number: check.phone!,
      dial_token: dialToken,
      consent_verified: true,
      tcpa_compliant: true,
      recording_disclosure_given: !!org?.voice_recording_enabled,
    })
    .select('id')
    .single()

  if (error || !callRecord) {
    logger.error('Failed to create staff call record', { lead_id: params.leadId }, error ? new Error(error.message) : undefined)
    return { error: 'Failed to prepare call', status: 500 }
  }

  return {
    dialToken,
    callId: callRecord.id,
    phone: check.phone!,
    fromNumber,
    recording: !!org?.voice_recording_enabled,
  }
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
    // Live-agent transfer: when set, tells the hosted-LLM agent it may hand off to
    // a human and how talkative to be first (immediate/greet/qualify).
    live_transfer?: boolean
    transfer_mode?: 'immediate' | 'greet_transfer' | 'qualify_transfer'
  }
): Promise<{ call_id: string; retell_call_id: string } | { error: string }> {
  const { organization_id, lead_id, lead, phone, voice_campaign_id, agent_type, live_transfer, transfer_mode } = params

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
    // Variable names MUST match the Retell hosted-LLM prompt ({{caller_*}}).
    // On an outbound call we already know who we're dialing, so populate the
    // name fields — otherwise the prompt falls back to its "new caller, ask for
    // the name" branch and greets as if the patient called us.
    retell_llm_dynamic_variables: {
      call_direction: 'outbound',
      practice_name: org.name || 'our practice',
      caller_first_name: (lead.first_name as string) || '',
      caller_full_name:
        `${(lead.first_name as string) || ''} ${(lead.last_name as string) || ''}`.trim() || '',
      // We initiated the call to an existing lead → they're a known/returning contact.
      is_new_lead: 'false',
      is_returning: 'true',
      // Live-transfer signalling for the hosted-LLM prompt. When live_transfer is
      // 'true', the agent should attempt a handoff via the transfer custom function
      // per transfer_mode (immediate → connect ASAP; greet → brief hello first;
      // qualify → discovery, then transfer only if interested).
      live_transfer: String(!!live_transfer),
      transfer_mode: transfer_mode || '',
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
      phi_categories: ['phone'],
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
  // Fetch current stats and increment
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
