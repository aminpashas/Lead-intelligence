/**
 * Onboarding Interview Agent — conducts the campaign-setup interview.
 *
 * It knows the shared core question pack plus the selected blueprint's add-on
 * pack, sees everything the practice has ALREADY answered (so it never
 * re-asks), and records answers through a single schema-validated tool
 * (`record_profile_answers` → mergeProfileAnswers). House rule applies: the
 * model writes prose and extracts answers; CODE decides launch readiness
 * (getProfileGaps) — the agent has no authority over eligibility, campaigns,
 * or sends.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ServiceLineSlug } from '@/lib/validators/practice-profile'
import { getBlueprint } from '@/lib/campaigns/blueprints'
import { getProfileGaps, questionsFor, type ProfileGap } from '@/lib/campaigns/onboarding'
import {
  mergeProfileAnswers,
  practiceProfileSummary,
  toProfileShape,
  type PracticeProfileRow,
} from '@/lib/campaigns/practice-profile'
import { buildAgencyRulesBlock } from './agency-rules'
import { recordAiUsage } from './usage'
import { upsertBranding } from '@/lib/branding/store'
import { brandingPatchSchema } from '@/lib/branding/schema'

const MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 1200
const MAX_TOOL_ROUNDS = 4

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

export type InterviewTurn = { role: 'user' | 'assistant'; content: string }

export interface InterviewResult {
  reply: string
  gaps: ProfileGap[]
  completeness: { answered: number; required: number }
  profile: PracticeProfileRow
}

const RECORD_TOOL: Anthropic.Messages.Tool = {
  name: 'record_profile_answers',
  description:
    'Save practice answers to the profile. Call this EVERY time the user reveals a fact, even ones you did not ask about. core = shared sections (hours, operations, appointments, consult_flow, technology, pricing, preferences); addon = answers to this service line\'s specific questions (flat keys). Send only the fields you learned — partial patches merge safely.',
  input_schema: {
    type: 'object' as const,
    properties: {
      core: {
        type: 'object',
        description:
          'Partial core sections, e.g. {"pricing": {"consult_fee_text": "$150, credited"}, "hours": {"weekly_text": "Mon-Fri 8-5"}}',
      },
      addon: {
        type: 'object',
        description: 'Partial service-line answers as flat keys, e.g. {"price_band_text": "..."}',
      },
    },
  },
}

const RECORD_BRANDING_TOOL: Anthropic.Messages.Tool = {
  name: 'record_branding',
  description:
    'Save how this practice is branded to patients. Use when the user names a brand/DBA, a doctor to name on calls, a website, or the office address/parking/transit. brands is keyed by slug: dion_health (implants), tmj_sleep (TMJ & sleep), sf_dentistry (general — the default). Set doctorName only where the practice wants the provider named (leave empty for general dentistry). logistics (address/parking/transit) is shared across all brands.',
  input_schema: {
    type: 'object' as const,
    properties: {
      brands: {
        type: 'object',
        description: 'Per-brand-slug partial, e.g. {"dion_health": {"name": "Dion Health", "doctorName": "Dr. Amin Samadian", "website": "dionhealth.com"}}',
      },
      logistics: {
        type: 'object',
        description: 'Shared office logistics: {"addressText": "...", "parkingText": "...", "transitText": "..."}',
      },
    },
  },
}

function buildSystemPrompt(args: {
  practiceName: string
  serviceLine: ServiceLineSlug
  profile: PracticeProfileRow
  gaps: ProfileGap[]
  agencyRules: string
  userName?: string
}): string {
  const blueprint = getBlueprint(args.serviceLine)
  const questions = [...questionsFor(blueprint).values()]
  const known = practiceProfileSummary(args.profile)

  return [
    `You are the campaign-onboarding interviewer for ${args.practiceName}, setting up their "${blueprint.name}" campaign${args.userName ? ` with ${args.userName}` : ''}.`,
    '',
    'Your job: learn how this practice actually operates so the campaign reflects reality. Be warm, efficient, and conversational — one topic at a time, no bureaucratic form-filling. When an answer implies other facts ("we only do consults Tuesdays with Dr. Kim"), record ALL of them.',
    '',
    'RULES:',
    '- Call record_profile_answers whenever you learn something — every fact, immediately, even mid-conversation.',
    '- Never re-ask anything listed under PRACTICE FACTS below. Confirm briefly if ambiguous, don\'t re-interview.',
    '- Prioritize the MISSING REQUIRED answers below; weave optional questions in naturally when relevant.',
    '- If the tool rejects an answer, re-ask that question more specifically.',
    '- You cannot launch campaigns, send messages, or promise anything on the practice\'s behalf. When all required answers are in, tell the user the checklist is complete and they can review and launch from this page.',
    '- Numbers the practice gives about pricing are recorded verbatim as their own framing — never embellish.',
    '- Also capture BRANDING when it comes up: the brand/DBA name patients should hear per service line (implants → Dion Health; TMJ/sleep → the TMJ & Sleep center; general → SF Dentistry), whether to name the doctor, each brand\'s website, and the office address/parking/transit. Record it with record_branding. Never invent or paraphrase a brand name — save it exactly as given.',
    '',
    `INTERVIEW GUIDE (${blueprint.name}):`,
    ...questions.map(
      (q) => `- [${q.required ? 'required' : 'optional'}] (${q.profilePath}) ${q.prompt}`
    ),
    '',
    args.gaps.length > 0
      ? `MISSING REQUIRED ANSWERS (${args.gaps.length}):\n${args.gaps.map((g) => `- (${g.path}) ${g.question}`).join('\n')}`
      : 'MISSING REQUIRED ANSWERS: none — the required checklist is complete.',
    '',
    known || 'PRACTICE FACTS: none recorded yet — this is a fresh interview.',
    args.agencyRules ? `\n${args.agencyRules}` : '',
  ].join('\n')
}

/**
 * Run one interview turn: model may call record_profile_answers multiple
 * times; merges are applied immediately and gaps recomputed from the DB.
 */
export async function runOnboardingInterview(args: {
  supabase: SupabaseClient
  orgId: string
  practiceName: string
  serviceLine: ServiceLineSlug
  history: InterviewTurn[]
  profile: PracticeProfileRow
  userName?: string
}): Promise<InterviewResult> {
  const { supabase, orgId, serviceLine } = args
  const blueprint = getBlueprint(serviceLine)
  const anthropic = getAnthropic()
  const startedAt = Date.now()

  let profile = args.profile
  const agencyRules = await buildAgencyRulesBlock(supabase)
  const system = buildSystemPrompt({
    practiceName: args.practiceName,
    serviceLine,
    profile,
    gaps: getProfileGaps(blueprint, toProfileShape(profile)),
    agencyRules,
    userName: args.userName,
  })

  const messages: Anthropic.Messages.MessageParam[] = args.history.map((t) => ({
    role: t.role,
    content: t.content,
  }))

  const usage = { input_tokens: 0, output_tokens: 0 }
  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages,
    tools: [RECORD_TOOL, RECORD_BRANDING_TOOL],
  })
  usage.input_tokens += response.usage?.input_tokens ?? 0
  usage.output_tokens += response.usage?.output_tokens ?? 0

  let rounds = 0
  while (response.stop_reason === 'tool_use' && rounds < MAX_TOOL_ROUNDS) {
    rounds++
    messages.push({ role: 'assistant', content: response.content })

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue

      if (block.name === 'record_branding') {
        const parsed = brandingPatchSchema.safeParse(block.input)
        if (!parsed.success) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Rejected: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
            is_error: true,
          })
        } else {
          const res = await upsertBranding(supabase, orgId, parsed.data)
          const failed = 'error' in res
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: failed ? `Could not save branding: ${res.error}` : 'Branding saved.',
            is_error: failed,
          })
        }
        continue
      }

      const input = (block.input ?? {}) as { core?: Record<string, unknown>; addon?: Record<string, unknown> }
      const merged = await mergeProfileAnswers(supabase, orgId, {
        core: input.core,
        addon: input.addon,
        slug: serviceLine,
      })
      if ('error' in merged) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `REJECTED — ${merged.error}. Re-ask the question and record it with the exact field names from the interview guide.`,
          is_error: true,
        })
      } else {
        profile = merged.profile
        const gaps = getProfileGaps(blueprint, toProfileShape(profile))
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content:
            gaps.length === 0
              ? 'Saved. All required answers are now complete.'
              : `Saved. Still missing ${gaps.length} required: ${gaps.map((g) => g.path).join(', ')}`,
        })
      }
    }

    messages.push({ role: 'user', content: toolResults })
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages,
      tools: [RECORD_TOOL, RECORD_BRANDING_TOOL],
    })
    usage.input_tokens += response.usage?.input_tokens ?? 0
    usage.output_tokens += response.usage?.output_tokens ?? 0
  }

  const textBlock = response.content.find((b) => b.type === 'text')
  const reply =
    textBlock && textBlock.type === 'text'
      ? textBlock.text
      : 'Got it — noted. What else can you tell me?'

  await recordAiUsage({
    supabase,
    organizationId: orgId,
    feature: 'onboarding_interview',
    model: MODEL,
    tokensIn: usage.input_tokens,
    tokensOut: usage.output_tokens,
    durationMs: Date.now() - startedAt,
    metadata: { service_line: serviceLine, tool_rounds: rounds },
  })

  const gaps = getProfileGaps(blueprint, toProfileShape(profile))
  return {
    reply,
    gaps,
    completeness: {
      answered: blueprint.requiredProfileFields.length - gaps.length,
      required: blueprint.requiredProfileFields.length,
    },
    profile,
  }
}
