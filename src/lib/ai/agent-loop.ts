/**
 * Shared multi-round agentic tool loop for the Setter and Closer agents.
 *
 * Why this exists: the original setter/closer entry points handled
 * `stop_reason === 'tool_use'` exactly ONCE — execute the tools, then force a
 * single final text turn. Any second tool_use the model emitted (e.g.
 * check_availability → then create_booking, or check_financing_status → then
 * send_financing_link) was silently dropped, capping the agent at one tool hop
 * per turn. That made it a reactive responder, not an agent that can complete a
 * multi-step action.
 *
 * This helper runs a proper loop: keep feeding tool_result blocks back to the
 * model until it returns a normal end_turn (or we hit MAX_ROUNDS as a runaway
 * backstop). Both agents share it so the behavior — and its safety cap — stays
 * in one place.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { executeAgentTool } from '@/lib/autopilot/agent-tools'

/** Hard cap on tool-execution rounds per agent turn (runaway-loop backstop). */
export const MAX_AGENT_ROUNDS = 5

export interface AgentToolContext {
  organization_id: string
  lead_id: string
  lead: Record<string, unknown>
  conversation_id: string
  channel?: string
  agent_role?: 'setter' | 'closer'
  /** HIPAA gate: when false, PHI-revealing tools refuse until verify_identity succeeds. */
  disclose_phi?: boolean
}

export interface AgentLoopResult {
  /** The final model message once it stops requesting tools (or hits the cap). */
  finalResponse: Anthropic.Messages.Message
  /** Extracted text content of the final message ('' if none). */
  responseText: string
  /** Every tool the agent actually executed across all rounds, in order. */
  toolCalls: Array<{ name: string; input: unknown; success: boolean; message: string }>
  /** Number of tool-execution rounds performed. */
  rounds: number
  /** True if the loop stopped because it hit MAX_AGENT_ROUNDS while still asking for tools. */
  hitRoundCap: boolean
  /** Summed token usage across every model call in the loop. */
  usage: { input_tokens: number; output_tokens: number }
}

/**
 * Drive an Anthropic tool-use conversation to completion.
 *
 * The caller owns the model / system prompt / max_tokens / tool list; this only
 * owns the loop and tool dispatch. `messages` is treated as the starting
 * transcript and is NOT mutated (a local copy is grown).
 */
export async function runAgentToolLoop(params: {
  anthropic: Anthropic
  supabase: SupabaseClient
  model: string
  maxTokens: number
  system: string
  messages: Anthropic.Messages.MessageParam[]
  tools: Anthropic.Messages.Tool[]
  toolContext: AgentToolContext
  maxRounds?: number
}): Promise<AgentLoopResult> {
  const {
    anthropic,
    supabase,
    model,
    maxTokens,
    system,
    tools,
    toolContext,
    maxRounds = MAX_AGENT_ROUNDS,
  } = params

  const messages: Anthropic.Messages.MessageParam[] = [...params.messages]
  const toolCalls: AgentLoopResult['toolCalls'] = []
  const usage = { input_tokens: 0, output_tokens: 0 }
  let rounds = 0
  let hitRoundCap = false

  let response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages,
    tools,
  })
  usage.input_tokens += response.usage?.input_tokens ?? 0
  usage.output_tokens += response.usage?.output_tokens ?? 0

  while (response.stop_reason === 'tool_use') {
    if (rounds >= maxRounds) {
      hitRoundCap = true
      break
    }
    rounds++

    // Echo the assistant's tool-use turn back into the transcript verbatim.
    messages.push({ role: 'assistant', content: response.content })

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const result = await executeAgentTool(
          supabase,
          block.name,
          block.input as Record<string, unknown>,
          toolContext
        )
        toolCalls.push({
          name: block.name,
          input: block.input,
          success: result.success ?? true,
          message: result.message,
        })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.message,
        })
      }
    }

    messages.push({ role: 'user', content: toolResults })

    response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages,
      tools,
    })
    usage.input_tokens += response.usage?.input_tokens ?? 0
    usage.output_tokens += response.usage?.output_tokens ?? 0
  }

  const textBlock = response.content.find((b) => b.type === 'text')
  const responseText = textBlock && textBlock.type === 'text' ? textBlock.text : ''

  return { finalResponse: response, responseText, toolCalls, rounds, hitRoundCap, usage }
}

/**
 * Derive a real confidence score from the model's own self-assessment.
 *
 * Replaces the old hardcoded 0.85/0.88 constants that drove every autopilot
 * auto-send-vs-escalate decision. The model now emits `self_confidence` in its
 * JSON; we clamp it to [0,1] and apply two guardrails:
 *   - a HIPAA/compliance critical issue caps confidence so the autopilot
 *     escalates to a human regardless of what the model claimed;
 *   - hitting the tool-round cap (an unfinished action) also caps it.
 * If the model omitted a usable value we fall back to a deliberately
 * middling default rather than an optimistic one.
 */
export function deriveConfidence(params: {
  selfConfidence: unknown
  hasCriticalCompliance: boolean
  hitRoundCap: boolean
  fallback?: number
}): number {
  const { selfConfidence, hasCriticalCompliance, hitRoundCap, fallback = 0.7 } = params

  let confidence: number
  if (typeof selfConfidence === 'number' && Number.isFinite(selfConfidence)) {
    confidence = Math.min(1, Math.max(0, selfConfidence))
  } else {
    confidence = fallback
  }

  // Guardrails force escalation no matter what the model asserted.
  if (hasCriticalCompliance) confidence = Math.min(confidence, 0.4)
  if (hitRoundCap) confidence = Math.min(confidence, 0.5)

  return confidence
}
