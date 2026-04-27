/**
 * Claude-backed contract narrative generator.
 *
 * The AI only writes ai_narrative sections. It never sees patient name,
 * tooth numbers, procedure codes, or dollar amounts. Output is forced through
 * a single `emit_contract_sections` tool so the caller gets structured data.
 *
 * Prompt caching (ephemeral): static rules + template instructions + org-legal
 * context blocks are cached so repeat generations against the same template +
 * org hit the cache.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { ContractTemplateSection } from '@/types/database'
import type { AiGenerateResult, AiSectionOutput, ContractContext } from './types'

const MODEL = 'claude-opus-4-7'
const FALLBACK_MODEL = 'claude-sonnet-4-5'

let _client: Anthropic | null = null
function getAnthropic(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  return _client
}

const STATIC_RULES = `You are a drafting assistant for a licensed dental practice. You write only the narrative sections of a patient contract template — not legal advice, not medical advice.

HARD RULES (violations get the section rejected):
1. Only emit sections whose section_id appears in the "Required sections" list of the user message.
2. Never invent procedures, fees, tooth numbers, dates, drug names, or provider names. Those come from data tables outside your output.
3. Never use "guarantee", "promise", "100%", "will cure", or absolute success claims.
4. Never diagnose, prescribe, or give medical advice. Say "as directed by your prescribing provider."
5. Use second person ("you") for patient-facing narrative sections.
6. Stay under the max_ai_words cap for each section.
7. Do NOT include markdown headings (no # or ##) — produce plain-text paragraphs.
8. Output ONLY through the emit_contract_sections tool. Do not produce free-text responses.`

function buildTemplateBlock(sections: ContractTemplateSection[]): string {
  const narrative = sections.filter((s) => s.kind === 'ai_narrative')
  const lines = narrative.map((s) => {
    const cap = s.max_ai_words ? ` (max ${s.max_ai_words} words)` : ''
    return `- ${s.id} — "${s.title}"${cap}\n  Instruction: ${s.ai_prompt ?? ''}`
  })
  return `Template narrative sections (id → instruction):\n${lines.join('\n\n')}`
}

function buildOrgLegalBlock(context: ContractContext): string {
  return [
    `Practice type: licensed dental practice providing implant treatment.`,
    `Jurisdiction of practice: ${context.legal.state_of_formation ?? 'unknown'}.`,
    `Cancellation window: ${context.legal.cancellation_policy_days} days.`,
    `Refund window: ${context.legal.refund_policy_days} days.`,
    `Tone: formal but accessible — written for a patient reading on a mobile device.`,
  ].join('\n')
}

function buildPerCaseBlock(context: ContractContext, requested: string[]): string {
  const generic = context.clinical_summary
  const phaseLine = generic.phase_item_counts
    .map((count, idx) => `Phase ${idx + 1}: ${count} item${count === 1 ? '' : 's'}`)
    .join('; ')
  return [
    `Chief complaint (scrubbed, generic): ${generic.chief_complaint_scrubbed}`,
    `Number of treatment phases: ${generic.phase_count}${phaseLine ? ` (${phaseLine})` : ''}`,
    `Financing type for this contract: ${context.financial.financing_type ?? 'cash'}`,
    `Required sections to emit: ${requested.join(', ')}`,
  ].join('\n')
}

const EMIT_SECTIONS_TOOL: Anthropic.Messages.Tool = {
  name: 'emit_contract_sections',
  description:
    'Emit the narrative sections of the contract. You must call this tool exactly once with all requested section_ids.',
  input_schema: {
    type: 'object' as const,
    required: ['sections'],
    properties: {
      sections: {
        type: 'array',
        description: 'Array of narrative sections. One entry per requested section_id.',
        items: {
          type: 'object',
          required: ['section_id', 'content'],
          properties: {
            section_id: { type: 'string' },
            content: { type: 'string', description: 'Plain-text paragraphs separated by blank lines. No markdown headings.' },
          },
        },
      },
    },
  },
}

function extractToolInput(msg: Anthropic.Messages.Message): AiSectionOutput[] {
  for (const block of msg.content) {
    if (block.type === 'tool_use' && block.name === 'emit_contract_sections') {
      const input = block.input as { sections?: AiSectionOutput[] } | undefined
      if (input?.sections && Array.isArray(input.sections)) {
        return input.sections.map((s) => ({
          section_id: String(s.section_id ?? ''),
          content: String(s.content ?? ''),
        }))
      }
    }
  }
  return []
}

export type GenerateOptions = {
  context: ContractContext
  template_sections: ContractTemplateSection[]
  // Which section ids to actually request (narrative-only). Defaults to all required narrative sections.
  requested_section_ids?: string[]
  extraUserReminder?: string
}

export async function generateContractNarrative(opts: GenerateOptions): Promise<AiGenerateResult> {
  const started = Date.now()
  const narrativeSections = opts.template_sections.filter((s) => s.kind === 'ai_narrative')
  const requested =
    opts.requested_section_ids ??
    narrativeSections.filter((s) => s.required !== false).map((s) => s.id)

  const templateBlock = buildTemplateBlock(opts.template_sections)
  const orgBlock = buildOrgLegalBlock(opts.context)
  const perCase = buildPerCaseBlock(opts.context, requested)

  const userMessage = `${perCase}

${opts.extraUserReminder ?? ''}

Call the emit_contract_sections tool now with all ${requested.length} requested sections.`

  const system: Anthropic.Messages.TextBlockParam[] = [
    { type: 'text', text: STATIC_RULES, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: templateBlock, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: orgBlock, cache_control: { type: 'ephemeral' } },
  ]

  let resp: Anthropic.Messages.Message
  let usedModel = MODEL
  try {
    resp = await getAnthropic().messages.create({
      model: MODEL,
      max_tokens: 4096,
      system,
      tools: [EMIT_SECTIONS_TOOL],
      tool_choice: { type: 'tool', name: 'emit_contract_sections' },
      messages: [{ role: 'user', content: userMessage }],
    })
  } catch (err) {
    // Fall back to Sonnet if Opus is unavailable
    console.error('[contracts/ai-generate] Opus unavailable, falling back to Sonnet', err)
    usedModel = FALLBACK_MODEL
    resp = await getAnthropic().messages.create({
      model: FALLBACK_MODEL,
      max_tokens: 4096,
      system,
      tools: [EMIT_SECTIONS_TOOL],
      tool_choice: { type: 'tool', name: 'emit_contract_sections' },
      messages: [{ role: 'user', content: userMessage }],
    })
  }

  const sections = extractToolInput(resp)
  const usage = resp.usage as { input_tokens?: number; output_tokens?: number } | undefined
  return {
    sections,
    tokens_in: usage?.input_tokens ?? 0,
    tokens_out: usage?.output_tokens ?? 0,
    model: usedModel,
    duration_ms: Date.now() - started,
  }
}
