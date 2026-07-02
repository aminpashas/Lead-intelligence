/**
 * Daily brief — the narrative that opens the dashboard.
 *
 * "LLM writes prose, code decides actions": every number in the brief is computed
 * by code (dashboard/page.tsx) and handed to Haiku as facts. The model only turns
 * facts into 3–4 readable sentences — it never invents figures or picks actions.
 *
 * Best-effort by design: any failure (no API key, budget, timeout) falls back to a
 * deterministic code-composed brief. The dashboard never breaks on an LLM error.
 *
 * Cached in-module per org for 15 minutes so page loads don't burn tokens. The
 * cache is per-serverless-instance, which is fine — worst case is one extra Haiku
 * call per warm instance per window.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { recordAiUsage } from './usage'

const BRIEF_MODEL = 'claude-haiku-4-5'
const MAX_OUTPUT_TOKENS = 300
const CACHE_TTL_MS = 15 * 60 * 1000

export type BriefFacts = {
  userName: string
  /** Distinct leads the AI messaged in the last 24h. */
  aiConversations24h: number
  /** Outbound AI-generated messages sent today. */
  aiSendsToday: number
  /** Appointments the AI booked in the last 24h. */
  consultsBookedByAi24h: number
  /** Items sitting in the "Needs you" queue right now. */
  pendingDecisions: number
  escalations: number
  noShowRisks: number
  goingCold: number
  hotLeads: number
  newLeadsThisWeek: number
  unreadMessages: number
  todayAppointments: number
  pipelineValue: number
  activeCampaigns: { name: string; enrolled: number }[]
  autopilotEnabled: boolean
  autopilotPaused: boolean
}

export type DailyBrief = {
  text: string
  source: 'ai' | 'fallback'
}

const BRIEF_PROMPT = `You write the morning brief at the top of a dental implant practice's CRM dashboard. You are the practice's AI assistant reporting on your own work, speaking in first person ("I").

Rules:
- 3 to 4 short sentences, plain language, no emoji, no bullet points, no headings.
- Use ONLY the numbers in the facts JSON. Never invent, estimate, or extrapolate a figure.
- Mention what you handled since yesterday, then the single most important thing needing the human's attention, then one notable observation (a campaign with zero enrollment, unread messages piling up, no appointments today).
- If autopilot is disabled or paused, say so plainly — it means you are not messaging anyone.
- Do not give medical or financial advice. Do not address the reader by name.`

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
}

const cache = new Map<string, { brief: DailyBrief; expires: number }>()

/** Deterministic brief used whenever the model can't run. */
export function fallbackBrief(f: BriefFacts): string {
  const parts: string[] = []
  if (!f.autopilotEnabled || f.autopilotPaused) {
    parts.push(
      f.autopilotPaused
        ? 'Autopilot is paused, so I am not messaging anyone right now.'
        : 'Autopilot is off, so I am not messaging anyone right now.'
    )
  } else if (f.aiConversations24h > 0 || f.consultsBookedByAi24h > 0) {
    const booked = f.consultsBookedByAi24h > 0 ? ` and booked ${f.consultsBookedByAi24h} consult${f.consultsBookedByAi24h === 1 ? '' : 's'}` : ''
    parts.push(`Since yesterday I messaged ${f.aiConversations24h} lead${f.aiConversations24h === 1 ? '' : 's'}${booked}.`)
  } else {
    parts.push('Quiet since yesterday — no AI conversations went out.')
  }
  if (f.pendingDecisions > 0) {
    parts.push(`${f.pendingDecisions} item${f.pendingDecisions === 1 ? '' : 's'} below need${f.pendingDecisions === 1 ? 's' : ''} your decision.`)
  } else {
    parts.push('Nothing needs your decision right now.')
  }
  if (f.unreadMessages > 0) parts.push(`You have ${f.unreadMessages} unread message${f.unreadMessages === 1 ? '' : 's'}.`)
  else if (f.todayAppointments === 0) parts.push('No appointments on the calendar today.')
  return parts.join(' ')
}

/**
 * Generate (or reuse) the org's daily brief. Never throws.
 */
export async function generateDailyBrief(
  supabase: SupabaseClient,
  params: { organizationId: string; facts: BriefFacts }
): Promise<DailyBrief> {
  const { organizationId, facts } = params

  const cached = cache.get(organizationId)
  if (cached && cached.expires > Date.now()) return cached.brief

  const fallback: DailyBrief = { text: fallbackBrief(facts), source: 'fallback' }

  if (!process.env.ANTHROPIC_API_KEY) return fallback

  const started = Date.now()
  try {
    const anthropic = getAnthropic()
    const response = await anthropic.messages.create({
      model: BRIEF_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: BRIEF_PROMPT,
      messages: [{ role: 'user', content: `Facts:\n${JSON.stringify(facts, null, 2)}` }],
    })

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()

    await recordAiUsage({
      supabase,
      organizationId,
      feature: 'daily_brief',
      model: BRIEF_MODEL,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      durationMs: Date.now() - started,
      succeeded: true,
    })

    if (!text) return fallback

    const brief: DailyBrief = { text, source: 'ai' }
    cache.set(organizationId, { brief, expires: Date.now() + CACHE_TTL_MS })
    return brief
  } catch (err) {
    await recordAiUsage({
      supabase,
      organizationId,
      feature: 'daily_brief',
      model: BRIEF_MODEL,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: Date.now() - started,
      succeeded: false,
      errorMessage: err instanceof Error ? err.message : 'unknown',
    }).catch(() => {})
    return fallback
  }
}
