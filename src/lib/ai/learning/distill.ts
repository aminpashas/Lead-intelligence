/**
 * Distillation — turn verified outcome contrasts into candidate agency rules.
 *
 * Weekly pass, three stages:
 *   1. Code computes contrastive Findings (contrast.ts) from learning_episodes
 *      + message_technique_tracking real outcomes. Statistical gates live there.
 *   2. Claude writes ONE candidate rule per prompt-fixable finding — prose
 *      only; it cannot invent findings, only articulate them.
 *   3. Candidates land in agency_ai_rules with is_enabled=false +
 *      review_status='pending'. A human approves via /agency/ai-learning (or
 *      rejects). Nothing auto-enables — a bad auto-rule would degrade every
 *      practice at once.
 *
 * Also runs the retirement pass: for live auto-learned rules ≥14 days old,
 * compare booked-rate of leads texted before vs after the rule went live and
 * flag significant regressions for human review.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type { LearningEpisode } from '@/types/database'
import {
  contrastTechniques,
  contrastEpisodeFeatures,
  twoProportionZ,
  POSITIVE_OUTCOMES,
  type Finding,
  type TechniqueOutcomeRow,
  type EpisodeForContrast,
} from './contrast'

const EPISODE_LOOKBACK_DAYS = 90
const MAX_CANDIDATES_PER_RUN = 5
const RETIREMENT_MIN_AGE_DAYS = 14
const RETIREMENT_WINDOW_DAYS = 30
const RETIREMENT_MIN_LEADS = 30

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
}

export type DistillationResult = {
  episodeCount: number
  techniqueRows: number
  findings: Finding[]
  candidatesCreated: number
  rulesFlagged: number
}

export async function runDistillation(supabase: SupabaseClient): Promise<DistillationResult> {
  const sinceIso = new Date(Date.now() - EPISODE_LOOKBACK_DAYS * 86400000).toISOString()

  // ── Stage 1: gather + contrast (code only) ─────────────────────
  const [{ data: episodes }, { data: techniqueRows }] = await Promise.all([
    supabase
      .from('learning_episodes')
      .select('outcome, outcome_at, journey, journey_stats')
      .gte('outcome_at', sinceIso)
      .order('outcome_at', { ascending: false })
      .limit(2000),
    supabase
      .from('message_technique_tracking')
      .select('technique_id, actual_effectiveness, agent_type')
      .not('actual_effectiveness', 'is', null)
      .gte('created_at', sinceIso)
      .limit(10000),
  ])

  const episodeList = (episodes || []) as Pick<
    LearningEpisode,
    'outcome' | 'outcome_at' | 'journey' | 'journey_stats'
  >[]
  const techniqueList = (techniqueRows || []) as TechniqueOutcomeRow[]

  const findings = [
    ...contrastTechniques(techniqueList),
    ...contrastEpisodeFeatures(episodeList as EpisodeForContrast[]),
  ]

  // Dedupe against every rule this loop has ever proposed (including rejected
  // ones — a rejected finding should not resurface every week).
  const { data: existingRules } = await supabase
    .from('agency_ai_rules')
    .select('evidence')
    .eq('source', 'auto_learning')
  const seenKeys = new Set(
    (existingRules || [])
      .map((r: { evidence: { finding_key?: string } | null }) => r.evidence?.finding_key)
      .filter(Boolean)
  )

  const fresh = findings.filter((f) => f.prompt_fixable && !seenKeys.has(f.key))
  const toDistill = fresh.slice(0, MAX_CANDIDATES_PER_RUN)

  // ── Stage 2: Claude articulates the rules ──────────────────────
  let candidatesCreated = 0
  if (toDistill.length > 0) {
    const examples = exampleSnippets(episodeList)
    const rules = await writeCandidateRules(toDistill, examples)

    for (const rule of rules) {
      const finding = toDistill.find((f) => f.key === rule.finding_key)
      if (!finding) continue // model may not fabricate rules for findings it wasn't given
      const { error } = await supabase.from('agency_ai_rules').insert({
        title: rule.title.slice(0, 120),
        content: rule.content,
        category: 'auto_learning',
        priority: 90, // below hand-authored SMS rules (100) on conflicts
        is_enabled: false, // NEVER live without human approval
        source: 'auto_learning',
        created_by: 'learning-loop',
        review_status: 'pending',
        evidence: {
          finding_key: finding.key,
          headline: finding.headline,
          detail: finding.detail,
          stats: finding.stats,
          examples,
        },
      })
      if (!error) candidatesCreated++
      else logger.warn('Candidate rule insert failed', { key: finding.key, error: error.message })
    }
  }

  // ── Stage 3: retirement pass on live auto-learned rules ────────
  const rulesFlagged = await flagUnderperformingRules(supabase)

  return {
    episodeCount: episodeList.length,
    techniqueRows: techniqueList.length,
    findings,
    candidatesCreated,
    rulesFlagged,
  }
}

/** A few scrubbed AI messages from winning journeys, as grounding examples. */
function exampleSnippets(
  episodes: Pick<LearningEpisode, 'outcome' | 'journey'>[]
): string[] {
  const snippets: string[] = []
  for (const ep of episodes) {
    if (!POSITIVE_OUTCOMES.includes(ep.outcome)) continue
    const aiMessages = (ep.journey || []).filter((j) => j.role === 'ai').slice(-2)
    for (const m of aiMessages) {
      if (m.body && m.body.length > 40) snippets.push(m.body)
      if (snippets.length >= 3) return snippets
    }
  }
  return snippets
}

type CandidateRule = { finding_key: string; title: string; content: string }

const DISTILL_SYSTEM_PROMPT = `You turn statistically verified sales-outcome findings into concise operating rules for AI patient-engagement agents (dental implant consultations, SMS/email).

For EACH finding you are given, write exactly one rule. Rules are injected into live agent system prompts, so:
- Be imperative and specific ("When X, do Y"), 2-4 sentences.
- Only instruct behavior the finding supports. Do not extrapolate.
- Never include patient names, numbers, or any personal details.
- Never promise pricing, financing terms, or clinical outcomes.

Return ONLY a JSON array: [{"finding_key": "<key from the finding>", "title": "<≤10 words>", "content": "<the rule>"}]`

async function writeCandidateRules(
  findings: Finding[],
  examples: string[]
): Promise<CandidateRule[]> {
  const prompt = `## Verified findings (code-computed from real outcomes; do not question or extend them)
${JSON.stringify(findings.map(({ key, headline, detail, stats }) => ({ key, headline, detail, stats })), null, 2)}

## Example messages from journeys that ended in a booked/attended consult (style reference only)
${examples.length > 0 ? examples.map((e) => `- "${e}"`).join('\n') : '(none available)'}

Write one rule per finding.`

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: DISTILL_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  const jsonMatch = text.match(/\[[\s\S]*\]/)
  if (!jsonMatch) throw new Error('Distillation: failed to parse rule JSON from model output')

  const parsed = JSON.parse(jsonMatch[0]) as CandidateRule[]
  return parsed.filter((r) => r.finding_key && r.title && r.content)
}

/**
 * Before/after cohort check per live auto-learned rule: booked-rate of leads
 * that received an AI message in the 30 days before the rule went live vs
 * after. Flags (never disables) significant regressions.
 */
async function flagUnderperformingRules(supabase: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - RETIREMENT_MIN_AGE_DAYS * 86400000).toISOString()
  const { data: liveRules } = await supabase
    .from('agency_ai_rules')
    .select('id, enabled_at')
    .eq('source', 'auto_learning')
    .eq('is_enabled', true)
    .lte('enabled_at', cutoff)
    .is('retired_at', null)

  let flagged = 0
  for (const rule of liveRules || []) {
    if (!rule.enabled_at) continue
    const enabledAt = new Date(rule.enabled_at)
    const before = await cohortBookedRate(
      supabase,
      new Date(enabledAt.getTime() - RETIREMENT_WINDOW_DAYS * 86400000),
      enabledAt
    )
    const after = await cohortBookedRate(
      supabase,
      enabledAt,
      new Date(Math.min(Date.now(), enabledAt.getTime() + RETIREMENT_WINDOW_DAYS * 86400000))
    )

    if (!before || !after) continue
    const z = twoProportionZ(after.rate, after.n, before.rate, before.n)
    const performance = {
      before,
      after,
      z: Math.round(z * 100) / 100,
      computed_at: new Date().toISOString(),
    }

    const shouldFlag = before.n >= RETIREMENT_MIN_LEADS && after.n >= RETIREMENT_MIN_LEADS && z <= -2
    const { error } = await supabase
      .from('agency_ai_rules')
      .update({
        performance,
        ...(shouldFlag ? { review_status: 'retire_flagged' } : {}),
      })
      .eq('id', rule.id)
    if (!error && shouldFlag) flagged++
  }
  return flagged
}

/**
 * Of leads that received ≥1 AI message in [start, end): what share had an
 * appointment created within 7 days of their first AI message in the window?
 */
async function cohortBookedRate(
  supabase: SupabaseClient,
  start: Date,
  end: Date
): Promise<{ n: number; rate: number } | null> {
  const { data: msgs } = await supabase
    .from('messages')
    .select('lead_id, created_at')
    .eq('ai_generated', true)
    .eq('direction', 'outbound')
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString())
    .order('created_at', { ascending: true })
    .limit(3000)

  if (!msgs || msgs.length === 0) return null

  // earliest AI message per lead in the window
  const firstByLead = new Map<string, string>()
  for (const m of msgs) {
    if (m.lead_id && !firstByLead.has(m.lead_id)) firstByLead.set(m.lead_id, m.created_at)
  }
  const leadIds = [...firstByLead.keys()].slice(0, 500)
  if (leadIds.length === 0) return null

  const { data: appts } = await supabase
    .from('appointments')
    .select('lead_id, created_at')
    .in('lead_id', leadIds)
    .gte('created_at', start.toISOString())
    .lte('created_at', new Date(end.getTime() + 7 * 86400000).toISOString())

  const booked = new Set<string>()
  for (const a of appts || []) {
    const firstMsgAt = firstByLead.get(a.lead_id)
    if (!firstMsgAt) continue
    const delta = new Date(a.created_at).getTime() - new Date(firstMsgAt).getTime()
    if (delta >= 0 && delta <= 7 * 86400000) booked.add(a.lead_id)
  }

  return { n: leadIds.length, rate: booked.size / leadIds.length }
}
