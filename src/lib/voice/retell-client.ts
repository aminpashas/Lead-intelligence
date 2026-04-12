/**
 * Retell AI Client — Voice AI Orchestration
 *
 * Wraps the Retell AI REST API for:
 * - Creating and managing voice agents
 * - Initiating outbound calls
 * - Handling call configuration
 * - Retrieving call data (transcripts, recordings)
 *
 * Retell handles: STT (speech-to-text), TTS (text-to-speech),
 * turn-taking, barge-in detection, and low-latency orchestration.
 * Our server provides the "brain" (Claude) via webhook.
 */

import { logger } from '@/lib/logger'

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type RetellAgentConfig = {
  agent_name: string
  response_engine: {
    type: 'retell-llm-websocket'
    llm_websocket_url: string // Our webhook URL that Retell calls
  }
  voice_id: string
  voice_model?: 'eleven_turbo_v2_5' | 'eleven_multilingual_v2'
  voice_temperature?: number // 0-2, controls expressiveness
  voice_speed?: number // 0.5-2.0
  language?: string
  ambient_sound?: 'off' | 'coffee-shop' | 'convention-hall' | 'summer-outdoor' | 'mountain-spring'
  responsiveness?: number // 0-1, how quickly agent responds
  interruption_sensitivity?: number // 0-1, how sensitive to barge-in
  enable_backchannel?: boolean // "uh-huh", "mm-hmm" during patient speech
  backchannel_frequency?: number // 0-1
  reminder_trigger_ms?: number // Nudge after silence
  reminder_max_count?: number
  normalize_for_speech?: boolean // Convert "$500" → "five hundred dollars"
  end_call_after_silence_ms?: number
  max_call_duration_ms?: number
  opt_out_sensitive_data_storage?: boolean
  post_call_analysis_data?: Array<'transcript' | 'recording_url' | 'call_summary'>
}

export type RetellCallConfig = {
  from_number: string
  to_number: string
  override_agent_id?: string
  metadata?: Record<string, string>
  retell_llm_dynamic_variables?: Record<string, string> // Injected into the LLM prompt
}

export type RetellCallResponse = {
  call_id: string
  call_status: string
  agent_id: string
}

export type RetellCallDetail = {
  call_id: string
  call_status: 'registered' | 'ongoing' | 'ended' | 'error'
  call_type: 'web_call' | 'phone_call'
  agent_id: string
  from_number: string
  to_number: string
  direction: 'inbound' | 'outbound'
  start_timestamp: number
  end_timestamp: number
  duration_ms: number
  transcript: string
  transcript_object: Array<{
    role: 'agent' | 'user'
    content: string
    words: Array<{ word: string; start: number; end: number }>
  }>
  recording_url: string | null
  public_log_url: string | null
  call_analysis: {
    call_summary: string
    user_sentiment: 'Positive' | 'Neutral' | 'Negative'
    call_successful: boolean
    custom_analysis_data: Record<string, unknown>
  } | null
  metadata: Record<string, string>
  disconnection_reason: string
}

export type RetellWebhookEvent = {
  event: 'call_started' | 'call_ended' | 'call_analyzed'
  call: RetellCallDetail
}

// Retell LLM WebSocket message types (what Retell sends to our webhook)
export type RetellLLMRequest = {
  interaction_type: 'call_details' | 'update_only' | 'response_required' | 'reminder_required'
  call: {
    call_id: string
    from_number: string
    to_number: string
    direction: string
    metadata: Record<string, string>
  }
  transcript: Array<{
    role: 'agent' | 'user'
    content: string
  }>
}

export type RetellLLMResponse = {
  response_id: number
  content: string
  content_complete: boolean
  end_call?: boolean
  transfer_number?: string
}

// ═══════════════════════════════════════════════════════════════
// CLIENT
// ═══════════════════════════════════════════════════════════════

const RETELL_API_BASE = 'https://api.retellai.com'

function getApiKey(): string {
  const key = process.env.RETELL_API_KEY
  if (!key) throw new Error('RETELL_API_KEY not configured')
  return key
}

async function retellFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${RETELL_API_BASE}${path}`
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'Unknown error')
    logger.error('Retell API error', {
      path,
      status: response.status,
      body: errorBody.substring(0, 500),
    })
    throw new Error(`Retell API error ${response.status}: ${errorBody.substring(0, 200)}`)
  }

  return response.json() as Promise<T>
}

// ═══════════════════════════════════════════════════════════════
// AGENT MANAGEMENT
// ═══════════════════════════════════════════════════════════════

/**
 * Create a Retell AI agent configured to use our webhook as the LLM backend.
 * The agent handles STT/TTS; our webhook provides the conversation logic.
 */
export async function createRetellAgent(config: RetellAgentConfig): Promise<{ agent_id: string }> {
  logger.info('Creating Retell agent', { name: config.agent_name })

  return retellFetch<{ agent_id: string }>('/create-agent', {
    method: 'POST',
    body: JSON.stringify({
      agent_name: config.agent_name,
      response_engine: config.response_engine,
      voice_id: config.voice_id,
      voice_model: config.voice_model || 'eleven_turbo_v2_5',
      voice_temperature: config.voice_temperature ?? 0.8,
      voice_speed: config.voice_speed ?? 1.0,
      language: config.language || 'en-US',
      ambient_sound: config.ambient_sound || 'off',
      responsiveness: config.responsiveness ?? 0.8,
      interruption_sensitivity: config.interruption_sensitivity ?? 0.6,
      enable_backchannel: config.enable_backchannel ?? true,
      backchannel_frequency: config.backchannel_frequency ?? 0.5,
      reminder_trigger_ms: config.reminder_trigger_ms ?? 10000,
      reminder_max_count: config.reminder_max_count ?? 2,
      normalize_for_speech: config.normalize_for_speech ?? true,
      end_call_after_silence_ms: config.end_call_after_silence_ms ?? 30000,
      max_call_duration_ms: config.max_call_duration_ms ?? 600000, // 10 min default
      opt_out_sensitive_data_storage: config.opt_out_sensitive_data_storage ?? false,
      post_call_analysis_data: config.post_call_analysis_data || ['transcript', 'recording_url', 'call_summary'],
    }),
  })
}

/**
 * Update an existing Retell agent's configuration.
 */
export async function updateRetellAgent(
  agentId: string,
  updates: Partial<RetellAgentConfig>
): Promise<{ agent_id: string }> {
  return retellFetch<{ agent_id: string }>(`/update-agent/${agentId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  })
}

/**
 * Get details of a Retell agent.
 */
export async function getRetellAgent(agentId: string): Promise<Record<string, unknown>> {
  return retellFetch<Record<string, unknown>>(`/get-agent/${agentId}`)
}

// ═══════════════════════════════════════════════════════════════
// CALL MANAGEMENT
// ═══════════════════════════════════════════════════════════════

/**
 * Initiate an outbound phone call via Retell.
 * Retell will call the number and connect to our LLM webhook.
 */
export async function createOutboundCall(
  agentId: string,
  config: RetellCallConfig
): Promise<RetellCallResponse> {
  logger.info('Creating outbound call via Retell', {
    agentId,
    to: config.to_number.replace(/\d(?=\d{4})/g, '*'), // mask number in logs
  })

  return retellFetch<RetellCallResponse>('/create-phone-call', {
    method: 'POST',
    body: JSON.stringify({
      agent_id: agentId,
      from_number: config.from_number,
      to_number: config.to_number,
      override_agent_id: config.override_agent_id,
      metadata: config.metadata,
      retell_llm_dynamic_variables: config.retell_llm_dynamic_variables,
    }),
  })
}

/**
 * Register a phone number for inbound calls with Retell.
 * When someone calls this number, Retell picks up and connects to the agent.
 */
export async function registerInboundNumber(
  agentId: string,
  phoneNumber: string
): Promise<{ phone_number: string; phone_number_id: string }> {
  return retellFetch('/import-phone-number', {
    method: 'POST',
    body: JSON.stringify({
      agent_id: agentId,
      phone_number: phoneNumber,
    }),
  })
}

/**
 * Get details of a specific call.
 */
export async function getCallDetail(callId: string): Promise<RetellCallDetail> {
  return retellFetch<RetellCallDetail>(`/get-call/${callId}`)
}

/**
 * List recent calls with optional filters.
 */
export async function listCalls(filters?: {
  agent_id?: string
  limit?: number
  sort_order?: 'ascending' | 'descending'
  filter_criteria?: Array<{
    member: string
    operator: string
    value: unknown
  }>
}): Promise<RetellCallDetail[]> {
  return retellFetch<RetellCallDetail[]>('/list-calls', {
    method: 'POST',
    body: JSON.stringify({
      limit: filters?.limit || 50,
      sort_order: filters?.sort_order || 'descending',
      ...(filters?.agent_id ? { agent_id: filters.agent_id } : {}),
      ...(filters?.filter_criteria ? { filter_criteria: filters.filter_criteria } : {}),
    }),
  })
}

/**
 * End an active call.
 */
export async function endCall(callId: string): Promise<void> {
  await retellFetch(`/end-call/${callId}`, { method: 'POST' })
}

// ═══════════════════════════════════════════════════════════════
// WEBHOOK SIGNATURE VERIFICATION
// ═══════════════════════════════════════════════════════════════

/**
 * Verify that a webhook request actually came from Retell.
 * Uses HMAC-SHA256 signature validation.
 */
export function verifyRetellWebhook(
  payload: string,
  signature: string
): boolean {
  const secret = process.env.RETELL_WEBHOOK_SECRET
  if (!secret) {
    logger.warn('RETELL_WEBHOOK_SECRET not configured — skipping verification')
    return true // Fail-open in dev, should be fail-closed in prod
  }

  try {
    // Retell uses HMAC-SHA256
    const crypto = require('crypto')
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex')

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    )
  } catch {
    return false
  }
}

// ═══════════════════════════════════════════════════════════════
// VOICE ID PRESETS (ElevenLabs voices available through Retell)
// ═══════════════════════════════════════════════════════════════

export const VOICE_PRESETS = {
  // Warm, professional female — ideal for patient coordination
  warm_female: '21m00Tcm4TlvDq8ikWAM', // Rachel
  professional_female: 'EXAVITQu4vr4xnSDxMaL', // Bella
  friendly_female: 'MF3mGyEYCl7XYWbV9V6O', // Elli

  // Professional male — good for treatment coordination
  professional_male: 'VR6AewLTigWG4xSOukaG', // Arnold
  warm_male: 'pNInz6obpgDQGcFmaJgB', // Adam
  friendly_male: 'yoZ06aMxZJJ28mfd3POQ', // Sam
} as const

export type VoicePresetName = keyof typeof VOICE_PRESETS
