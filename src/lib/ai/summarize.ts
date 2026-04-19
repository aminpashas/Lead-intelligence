/**
 * Conversation summarizer.
 *
 * Produces a rolling summary of a conversation so that:
 *   - staff can scan the thread without reading every message
 *   - downstream agents (autopilot, scoring) skip re-loading full transcripts
 *
 * Writes to `conversations.summary`. Debounced — won't re-summarize unless at least
 * `MIN_NEW_MESSAGES` new messages have arrived since the last summary.
 *
 * Brief reference: Section 3.1 (post-call + post-message summarization).
 *
 * Wired into:
 *   - src/app/api/webhooks/twilio/route.ts          (inbound SMS)
 *   - src/app/api/webhooks/cal/route.ts             (booking events)
 *   - src/lib/voice/voice-agent.ts                  (Retell post-call) — TODO
 */

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { recordAiUsage, isUnderDailyBudget } from './usage'

const SUMMARIZE_MODEL = 'claude-haiku-4-5'
const MIN_NEW_MESSAGES = 2          // don't re-summarize on every single inbound SMS
const MAX_HISTORY_MESSAGES = 50     // never feed more than the last N messages to Claude
const MAX_OUTPUT_TOKENS = 350

const SUMMARIZE_PROMPT = `You are summarizing a conversation between a dental implant practice and a prospective patient.

Produce a concise summary (3-5 short paragraphs MAX) that captures:
1. **Patient situation** — what dental issue brought them in, what they've shared
2. **Engagement signals** — interest level, objections, financing concerns, urgency
3. **Open threads** — any specific question they asked that hasn't been answered, any commitment we made (e.g. "we'll send pricing")
4. **Recommended next step** — one sentence

Write in third person. Use plain language, no emoji, no marketing-speak. Be specific — names, numbers, exact concerns. If the conversation is too short to summarize meaningfully, return: "Conversation too brief to summarize."`

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
}

export type SummarizeResult = {
  status: 'updated' | 'skipped_debounced' | 'skipped_budget' | 'skipped_empty' | 'failed'
  summary?: string
  message_count?: number
  error?: string
}

/**
 * Summarize a conversation if it has changed enough since the last pass.
 * Best-effort: always returns a result, never throws — the caller (webhook) shouldn't fail
 * because summarization had a hiccup.
 */
export async function summarizeConversation(
  supabase: SupabaseClient,
  params: {
    conversationId: string
    organizationId: string
    leadId: string
  }
): Promise<SummarizeResult> {
  // Pull conversation + message count + previous summary state
  const { data: convo } = await supabase
    .from('conversations')
    .select('id, summary, summary_message_count, message_count')
    .eq('id', params.conversationId)
    .single()

  if (!convo) return { status: 'failed', error: 'conversation_not_found' }

  const currentCount = (convo.message_count as number) || 0
  const lastCount = (convo.summary_message_count as number) || 0

  if (currentCount < 2) {
    return { status: 'skipped_empty' }
  }

  if (currentCount - lastCount < MIN_NEW_MESSAGES) {
    return { status: 'skipped_debounced' }
  }

  // Token budget guard
  if (!(await isUnderDailyBudget(supabase, params.leadId))) {
    return { status: 'skipped_budget' }
  }

  // Pull the most recent N messages (oldest → newest order)
  const { data: messages } = await supabase
    .from('messages')
    .select('direction, sender_type, channel, body, created_at')
    .eq('conversation_id', params.conversationId)
    .order('created_at', { ascending: false })
    .limit(MAX_HISTORY_MESSAGES)

  if (!messages || messages.length === 0) {
    return { status: 'skipped_empty' }
  }

  const transcript = messages
    .reverse()
    .map((m: { direction: string; sender_type: string; channel: string; body: string }) => {
      const speaker =
        m.direction === 'inbound'
          ? 'Patient'
          : m.sender_type === 'ai'
          ? 'AI'
          : m.sender_type === 'staff'
          ? 'Staff'
          : 'System'
      return `[${m.channel}] ${speaker}: ${m.body}`
    })
    .join('\n')

  const startedAt = Date.now()
  try {
    const response = await getAnthropic().messages.create({
      model: SUMMARIZE_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SUMMARIZE_PROMPT,
      messages: [{ role: 'user', content: `Conversation transcript:\n\n${transcript}` }],
    })

    const summary = response.content
      .filter((c) => c.type === 'text')
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n')
      .trim()

    if (!summary) {
      return { status: 'failed', error: 'empty_response' }
    }

    await supabase
      .from('conversations')
      .update({
        summary,
        summary_updated_at: new Date().toISOString(),
        summary_message_count: currentCount,
      })
      .eq('id', params.conversationId)

    await recordAiUsage({
      supabase,
      organizationId: params.organizationId,
      leadId: params.leadId,
      feature: 'summarize',
      model: SUMMARIZE_MODEL,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      durationMs: Date.now() - startedAt,
      succeeded: true,
      metadata: { conversation_id: params.conversationId, message_count: currentCount },
    })

    return { status: 'updated', summary, message_count: currentCount }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown'
    await recordAiUsage({
      supabase,
      organizationId: params.organizationId,
      leadId: params.leadId,
      feature: 'summarize',
      model: SUMMARIZE_MODEL,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: Date.now() - startedAt,
      succeeded: false,
      errorMessage: message,
    })
    return { status: 'failed', error: message }
  }
}
