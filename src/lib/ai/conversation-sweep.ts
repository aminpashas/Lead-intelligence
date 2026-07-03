/**
 * Compact Conversation Sweep Analyzer
 *
 * Bulk-friendly sibling of the deep conversation analyst: classifies a lead's
 * most recent conversation into a handful of enum fields (intent, sentiment,
 * primary objection, red flag) and persists them onto the lead row so Smart
 * Lists can segment on them.
 *
 * Runs from /api/cron/analyze-conversations across every active org. Uses
 * Haiku with a tiny output budget — the deep analyst (conversation-analyst.ts)
 * stays reserved for on-demand Insights-panel analysis.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildSafeConversationHistory, buildSafeLeadContext, logHIPAAEvent } from './hipaa'
import {
  CONVERSATION_INTENTS,
  CONVERSATION_SENTIMENTS,
  PRIMARY_OBJECTIONS,
} from '@/lib/validators/smart-list'
import type {
  ConversationIntent,
  ConversationSentiment,
  PrimaryObjection,
} from '@/types/database'

const SWEEP_MODEL = 'claude-haiku-4-5'

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
}

export type CompactConversationAnalysis = {
  intent: ConversationIntent
  sentiment: ConversationSentiment
  primary_objection: PrimaryObjection
  red_flag: boolean
  red_flag_reason: string | null
}

const SWEEP_PROMPT = `You classify dental-implant practice patient conversations for CRM segmentation. Read the conversation and output ONLY a JSON object with these fields:

- "intent": how close is the patient to booking a consultation?
  - "ready_to_book": asking about scheduling, availability, next steps, or explicitly agreeing to come in
  - "considering": engaged and asking substantive questions (cost, procedure, financing) but not committing yet
  - "exploring": early curiosity, gathering general information
  - "resistant": pushing back, deflecting, raising repeated objections, or mentioning competitors
  - "disengaged": short/absent replies, has stopped responding meaningfully
- "sentiment": overall emotional tenor of the PATIENT's messages — "positive" | "neutral" | "mixed" | "negative"
- "primary_objection": the single biggest obstacle the patient expressed — "cost" | "financing" | "fear_anxiety" | "timing" | "trust" | "medical" | "logistics" | "spouse_approval" | "none" | "other". Use "none" if no obstacle was expressed.
- "red_flag": true ONLY for serious issues — explicit complaints, threats of bad reviews or legal action, signs the patient feels misled or pressured, or clear do-not-contact requests that weren't honored
- "red_flag_reason": one short sentence when red_flag is true, otherwise null

Base everything on what the patient actually said, not what staff said. Output only the JSON object.`

/**
 * Classify one conversation and persist the compact result onto the lead.
 */
export async function analyzeConversationCompact(
  supabase: SupabaseClient,
  config: {
    organization_id: string
    lead_id: string
    conversation_id: string
    lead: Record<string, unknown>
    messages: Array<{
      direction: string
      body: string
      sender_type: string
      created_at: string
    }>
  }
): Promise<CompactConversationAnalysis> {
  if (config.messages.length < 2) {
    throw new Error('Need at least 2 messages to analyze a conversation')
  }

  const safeHistory = buildSafeConversationHistory(config.messages)
  const safeLeadContext = buildSafeLeadContext(config.lead)

  await logHIPAAEvent(supabase, {
    organization_id: config.organization_id,
    event_type: 'ai_processing',
    severity: 'info',
    actor_type: 'ai_agent',
    actor_id: 'conversation_sweep_agent',
    resource_type: 'conversation',
    resource_id: config.conversation_id,
    description: `Conversation sweep classifying ${config.messages.length} messages (PHI-scrubbed)`,
  })

  const prompt = `## Patient Context
${safeLeadContext}

## Conversation (${config.messages.length} messages)
${safeHistory.map((m) => `[${m.role === 'user' ? 'PATIENT' : 'STAFF'}] ${m.content}`).join('\n\n')}`

  const response = await getAnthropic().messages.create({
    model: SWEEP_MODEL,
    max_tokens: 300,
    system: SWEEP_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse conversation sweep response')
  const raw = JSON.parse(jsonMatch[0]) as Record<string, unknown>

  // Coerce to the canonical enums — never trust free-form model output into
  // columns that smart lists filter with exact .in() matches.
  const analysis: CompactConversationAnalysis = {
    intent: (CONVERSATION_INTENTS as readonly string[]).includes(String(raw.intent))
      ? (raw.intent as ConversationIntent) : 'exploring',
    sentiment: (CONVERSATION_SENTIMENTS as readonly string[]).includes(String(raw.sentiment))
      ? (raw.sentiment as ConversationSentiment) : 'neutral',
    primary_objection: (PRIMARY_OBJECTIONS as readonly string[]).includes(String(raw.primary_objection))
      ? (raw.primary_objection as PrimaryObjection) : 'other',
    red_flag: raw.red_flag === true,
    red_flag_reason: raw.red_flag === true && typeof raw.red_flag_reason === 'string'
      ? raw.red_flag_reason.slice(0, 300) : null,
  }

  const { error } = await supabase
    .from('leads')
    .update({
      conversation_intent: analysis.intent,
      conversation_sentiment: analysis.sentiment,
      primary_objection: analysis.primary_objection,
      conversation_red_flag: analysis.red_flag,
      conversation_analyzed_at: new Date().toISOString(),
    })
    .eq('id', config.lead_id)
    .eq('organization_id', config.organization_id)
  if (error) throw new Error(`Failed to persist sweep result: ${error.message}`)

  // Red flags get an activity-trail entry so staff can see why a lead landed
  // in a red-flag smart list (and the escalation queue can pick it up later).
  if (analysis.red_flag) {
    await supabase.from('lead_activities').insert({
      organization_id: config.organization_id,
      lead_id: config.lead_id,
      activity_type: 'conversation_red_flag',
      title: 'AI flagged latest conversation',
      metadata: {
        reason: analysis.red_flag_reason,
        conversation_id: config.conversation_id,
        intent: analysis.intent,
        sentiment: analysis.sentiment,
      },
    })
  }

  await supabase.from('ai_interactions').insert({
    organization_id: config.organization_id,
    lead_id: config.lead_id,
    interaction_type: 'classification',
    model: SWEEP_MODEL,
    prompt_tokens: response.usage?.input_tokens || 0,
    completion_tokens: response.usage?.output_tokens || 0,
    total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
    output_summary: `Conversation sweep: intent=${analysis.intent}, sentiment=${analysis.sentiment}, objection=${analysis.primary_objection}${analysis.red_flag ? ', RED FLAG' : ''}`,
    success: true,
    metadata: {
      agent: 'conversation_sweep',
      conversation_id: config.conversation_id,
      message_count: config.messages.length,
    },
  })

  return analysis
}
