/**
 * Retell LLM Webhook — Real-Time Voice Agent Endpoint
 *
 * This is the "brain" endpoint that Retell calls in real-time during
 * every voice call. When Retell converts the patient's speech to text,
 * it sends the transcript here. We process it through our Setter/Closer
 * agents and return the AI's text response, which Retell converts to speech.
 *
 * Flow:
 * 1. Patient speaks → Retell STT → transcript sent here
 * 2. This handler → routeToAgent() → Claude generates response
 * 3. Response text returned → Retell TTS → patient hears response
 *
 * This is a POST-based streaming endpoint. Retell expects responses
 * as newline-delimited JSON objects. For low latency, we stream
 * the response as it's generated.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { processVoiceTranscript, type VoiceAgentContext } from '@/lib/voice/voice-agent'
import { verifyRetellWebhook } from '@/lib/voice/retell-client'
import type { RetellLLMRequest, RetellLLMResponse } from '@/lib/voice/retell-client'
import { logger } from '@/lib/logger'

// POST /api/voice/webhook — Retell LLM webhook
export async function POST(request: NextRequest) {
  const rawBody = await request.text()

  // Verify webhook signature in production
  if (process.env.NODE_ENV === 'production') {
    const signature = request.headers.get('x-retell-signature') || ''
    if (!verifyRetellWebhook(rawBody, signature)) {
      return new NextResponse('Invalid signature', { status: 401 })
    }
  }

  let retellRequest: RetellLLMRequest
  try {
    retellRequest = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Extract context from the call metadata
  const metadata = retellRequest.call?.metadata || {}
  const callId = metadata.call_id
  const organizationId = metadata.organization_id
  const leadId = metadata.lead_id
  const conversationId = metadata.conversation_id

  // For call_details event (first interaction), we may need to look up from DB
  if (!callId && retellRequest.interaction_type === 'call_details') {
    // Retell is telling us about a new call — handle via retell event webhook instead
    return NextResponse.json({
      response_id: 0,
      content: 'Hello! Thanks for reaching out. How can I help you today?',
      content_complete: true,
    } satisfies RetellLLMResponse)
  }

  if (!organizationId || !leadId || !conversationId) {
    logger.error('Voice webhook: missing context in metadata', { metadata })
    return NextResponse.json({
      response_id: 0,
      content: "I'm having a little trouble right now. Please call us back in a few minutes.",
      content_complete: true,
      end_call: true,
    } satisfies RetellLLMResponse)
  }

  // Load lead data
  const { data: lead } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .eq('organization_id', organizationId)
    .single()

  if (!lead) {
    return NextResponse.json({
      response_id: 0,
      content: "I apologize, I'm experiencing a technical issue. Can I have someone call you back?",
      content_complete: true,
      end_call: true,
    } satisfies RetellLLMResponse)
  }

  // Load conversation
  const { data: conversation } = await supabase
    .from('conversations')
    .select('*')
    .eq('id', conversationId)
    .single()

  // Build voice agent context
  const voiceContext: VoiceAgentContext = {
    organization_id: organizationId,
    lead_id: leadId,
    lead,
    conversation_id: conversationId,
    conversation: conversation || {},
    call_id: callId || 'unknown',
    direction: (retellRequest.call?.direction as 'inbound' | 'outbound') || 'inbound',
  }

  // Process through the voice agent (same AI brain as SMS/email)
  try {
    const result = await processVoiceTranscript(supabase, retellRequest, voiceContext)

    const response: RetellLLMResponse = {
      response_id: 0,
      content: result.response,
      content_complete: true,
      end_call: result.end_call || false,
      ...(result.transfer_number ? { transfer_number: result.transfer_number } : {}),
    }

    return NextResponse.json(response)
  } catch (error) {
    logger.error('Voice webhook processing error', { callId }, error instanceof Error ? error : undefined)

    return NextResponse.json({
      response_id: 0,
      content: "I'm so sorry, I'm having a little trouble on my end. Let me connect you with someone who can help.",
      content_complete: true,
      end_call: false,
    } satisfies RetellLLMResponse)
  }
}
