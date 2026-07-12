/**
 * LLM Pipeline Analyst (Workstream C2)
 *
 * A second, non-authoritative layer on top of the deterministic rules engine:
 * once an hour (from /api/cron/pipeline-recommendations) Sonnet reads AGGREGATE
 * pipeline statistics — per-stage counts/EV, the open recommendations, and
 * org-level GROUP-BY numbers (objections, sentiment). It may:
 *
 *   1. RERANK existing open recommendations (adjust priority 0-100), and
 *   2. Propose at most 2 new "insight" segments the rules missed.
 *
 * PHI posture: the model NEVER sees a lead. Input is counts and enum
 * distributions only — no names, phones, or message content.
 *
 * Anti-hallucination gates (hard requirements — see gateAnalystOutput):
 *   (a) strict JSON parse + zod shape validation;
 *   (b) every insight's segment_criteria must pass smartListCriteriaSchema AND
 *       resolve to a real, non-empty segment via the smart-list resolver;
 *   (c) every number > 10 in an insight detail / rerank reasoning must appear
 *       in the input aggregates (or be the insight's own resolved count) —
 *       small numbers (≤ 10) and calendar years are allowed;
 *   (d) reranks only apply to existing dedupe_keys, priority clamped to 0-100.
 * Rejections are logged and returned, never thrown — the deterministic band
 * stands on its own when the analyst misbehaves or the API is down.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { SmartListCriteria } from '@/types/database'
import {
  smartListCriteriaSchema,
  CONVERSATION_SENTIMENTS,
  PRIMARY_OBJECTIONS,
} from '@/lib/validators/smart-list'
import { resolveSmartListLeads } from '@/lib/campaigns/smart-list-resolver'
import type { PipelineSignals, RecommendationEvidence } from './recommendations'
import {
  upsertAnalystInsight,
  expireMissingAnalystInsights,
  type PipelineRecommendationRow,
} from './recommendation-store'

export const ANALYST_MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 1500

/** Default priority for accepted insights (model doesn't set one; mid-band so
 *  deterministic high-urgency recs still render first). */
const INSIGHT_DEFAULT_PRIORITY = 50

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
}

export const ANALYST_SYSTEM_PROMPT = `You are a sales-pipeline analyst for a dental practice CRM. You receive AGGREGATE pipeline statistics (never individual patients) and the currently open rule-generated recommendations.

Your job:
1. Rerank: adjust the priority (0-100) of existing open recommendations when the aggregates justify it. Reference recommendations ONLY by their exact dedupe_key from the input. Keep reasoning to one short sentence.
2. Insights: propose at most 2 NEW actionable segments the rules missed. Each insight needs a kebab-case slug, a short title, a one-to-two-sentence detail, and segment_criteria.

segment_criteria may use ONLY these fields:
- "stages": array of stage UUIDs exactly as given in the input
- "ai_qualifications": array of "hot" | "warm" | "cold" | "unqualified"
- "conversation_intents": array of "ready_to_book" | "considering" | "exploring" | "resistant" | "disengaged"
- "conversation_sentiments": array of "positive" | "neutral" | "mixed" | "negative"
- "primary_objections": array of "cost" | "financing" | "fear_anxiety" | "timing" | "trust" | "medical" | "logistics" | "spouse_approval" | "none" | "other"
- "has_phone": boolean, "sms_consent": boolean, "never_contacted": boolean
- "last_contacted_before": ISO datetime string
- "score_min" / "score_max": number 0-100

Hard rules:
- Use ONLY numbers that appear in the input data. NEVER invent counts, percentages, or dollar figures.
- Never include patient names or contact details (you have none).
- If nothing is worth changing, output empty arrays.
- Output ONLY a JSON object, no prose, exactly this shape:
{"reranks": [{"dedupe_key": "<existing key>", "priority": <0-100>, "reasoning": "<one sentence>"}], "insights": [{"slug": "<kebab-case>", "title": "<short>", "detail": "<1-2 sentences>", "segment_criteria": {…}, "kind": "analyst_insight"}]}`

// ── Input (aggregates only — the PHI boundary lives here) ────────────────────

export type AnalystStageStat = {
  stageId: string
  stageName: string
  kind: 'sales' | 'operational'
  staleReachableSms: number
  hotWarmReachableSms: number
  neverContacted: number
  readyToBook: number
  deliberatingDue: number
  expectedValueUsd: number | null
}

export type AnalystOpenRec = {
  dedupe_key: string
  kind: string
  title: string
  lead_count: number
  expected_value_usd: number | null
  priority: number
}

export type AnalystInput = {
  staleDays: number
  stages: AnalystStageStat[]
  openRecommendations: AnalystOpenRec[]
  /** Top-5 GROUP-BY counts of leads.primary_objection (non-null values). */
  topObjections: Array<{ objection: string; count: number }>
  /** GROUP-BY counts of leads.conversation_sentiment. */
  sentimentDistribution: Array<{ sentiment: string; count: number }>
  /** Conversion-relevant aggregates. */
  conversions: { converted_last_30d: number }
}

/** Sum the fetched per-signal EVs into one per-stage dollar figure. */
function stageEv(ev: NonNullable<PipelineSignals['stages'][number]['ev']> | undefined): number | null {
  if (!ev) return null
  let sum = 0
  let any = false
  for (const v of Object.values(ev)) {
    if (v) {
      sum += v.expectedValueUsd
      any = true
    }
  }
  return any ? Math.round(sum) : null
}

/**
 * Build the analyst's aggregate input for one org. Every query is a bounded
 * head-count (GROUP BY emulated as one count per enum value — ≤ 15 queries).
 */
export async function buildAnalystInput(
  supabase: SupabaseClient,
  orgId: string,
  signals: PipelineSignals,
  openRows: Array<Pick<PipelineRecommendationRow, 'dedupe_key' | 'kind' | 'title' | 'lead_count' | 'expected_value_usd' | 'priority'>>,
  nowMs: number = Date.now()
): Promise<AnalystInput> {
  const countWhere = async (apply: (q: ReturnType<typeof base>) => ReturnType<typeof base>) => {
    const { count } = await apply(base())
    return count ?? 0
  }
  const base = () =>
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)

  const [objectionEntries, sentimentEntries, converted30] = await Promise.all([
    Promise.all(
      PRIMARY_OBJECTIONS.filter((o) => o !== 'none').map(
        async (o) => [o, await countWhere((q) => q.eq('primary_objection', o))] as const
      )
    ),
    Promise.all(
      CONVERSATION_SENTIMENTS.map(
        async (s) => [s, await countWhere((q) => q.eq('conversation_sentiment', s))] as const
      )
    ),
    countWhere((q) =>
      q.gt('converted_at', new Date(nowMs - 30 * 86_400_000).toISOString())
    ),
  ])

  return {
    staleDays: signals.staleDays,
    stages: signals.stages.map((s) => ({
      stageId: s.stageId,
      stageName: s.stageName,
      kind: s.kind,
      staleReachableSms: s.staleReachableSms,
      hotWarmReachableSms: s.hotWarmReachableSms,
      neverContacted: s.neverContacted,
      readyToBook: s.readyToBook,
      deliberatingDue: s.deliberatingDue,
      expectedValueUsd: stageEv(s.ev),
    })),
    openRecommendations: openRows.map((r) => ({
      dedupe_key: r.dedupe_key,
      kind: r.kind,
      title: r.title,
      lead_count: r.lead_count,
      expected_value_usd: r.expected_value_usd == null ? null : Number(r.expected_value_usd),
      priority: r.priority,
    })),
    topObjections: objectionEntries
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([objection, count]) => ({ objection, count })),
    sentimentDistribution: sentimentEntries
      .filter(([, c]) => c > 0)
      .map(([sentiment, count]) => ({ sentiment, count })),
    conversions: { converted_last_30d: converted30 },
  }
}

// ── Output schema + anti-hallucination gates ─────────────────────────────────

const rerankSchema = z.object({
  dedupe_key: z.string().min(1).max(200),
  priority: z.number(),
  reasoning: z.string().max(600).default(''),
})

const insightSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/, 'slug must be kebab-case'),
  title: z.string().min(1).max(140),
  detail: z.string().min(1).max(600),
  segment_criteria: z.record(z.string(), z.unknown()),
  kind: z.literal('analyst_insight'),
})

const analystOutputSchema = z.object({
  reranks: z.array(rerankSchema).max(20).default([]),
  insights: z.array(insightSchema).max(2).default([]),
})

export type AnalystRerank = z.infer<typeof rerankSchema>
export type AnalystInsight = z.infer<typeof insightSchema>

export type AnalystRejection = { item: 'rerank' | 'insight' | 'output'; ref: string; reason: string }

export type GatedAnalystOutput = {
  reranks: Array<{ dedupe_key: string; priority: number; reasoning: string }>
  insights: Array<{
    slug: string
    title: string
    detail: string
    criteria: SmartListCriteria
    resolvedCount: number
  }>
  rejections: AnalystRejection[]
}

/** Walk any JSON-ish value and collect every number (plus its rounding) — the
 *  set of figures the model is allowed to cite. */
export function collectAllowedNumbers(value: unknown, into: Set<number> = new Set()): Set<number> {
  if (typeof value === 'number' && Number.isFinite(value)) {
    into.add(value)
    into.add(Math.round(value))
  } else if (Array.isArray(value)) {
    for (const v of value) collectAllowedNumbers(v, into)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectAllowedNumbers(v, into)
  }
  return into
}

/** Extract every numeric literal from prose ("$52,340", "142 leads", "3.5%"). */
export function extractNumbers(text: string): number[] {
  const matches = text.match(/\d[\d,]*(?:\.\d+)?/g)
  if (!matches) return []
  return matches
    .map((m) => Number.parseFloat(m.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n))
}

/** Gate (c): a cited number is grounded if it's small (≤10 — "2 stages"),
 *  a calendar year, or literally present in the allowed set. */
function ungroundedNumbers(text: string, allowed: Set<number>): number[] {
  return extractNumbers(text).filter(
    (n) => n > 10 && !(n >= 1900 && n <= 2100) && !allowed.has(n)
  )
}

/**
 * Apply every anti-hallucination gate to a raw model reply. Never throws;
 * everything invalid lands in `rejections` with a reason.
 *
 * `resolveCount` is injected (the smart-list resolver in production, a stub in
 * tests) and is only called with schema-valid criteria.
 */
export async function gateAnalystOutput(
  rawText: string,
  input: AnalystInput,
  resolveCount: (criteria: SmartListCriteria) => Promise<number>
): Promise<GatedAnalystOutput> {
  const rejections: AnalystRejection[] = []
  const out: GatedAnalystOutput = { reranks: [], insights: [], rejections }

  // (a) strict parse — the reply must contain exactly one JSON object.
  let parsed: unknown
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('no JSON object in reply')
    parsed = JSON.parse(jsonMatch[0])
  } catch (e) {
    rejections.push({
      item: 'output',
      ref: 'reply',
      reason: `parse_error: ${e instanceof Error ? e.message : 'invalid JSON'}`,
    })
    return out
  }

  const shape = analystOutputSchema.safeParse(parsed)
  if (!shape.success) {
    rejections.push({ item: 'output', ref: 'reply', reason: `schema_error: ${shape.error.message.slice(0, 300)}` })
    return out
  }

  const allowed = collectAllowedNumbers(input)
  const openKeys = new Set(input.openRecommendations.map((r) => r.dedupe_key))

  // (d) reranks: existing keys only, clamped priority; (c) grounded reasoning.
  for (const rerank of shape.data.reranks) {
    if (!openKeys.has(rerank.dedupe_key)) {
      rejections.push({ item: 'rerank', ref: rerank.dedupe_key, reason: 'unknown_dedupe_key' })
      continue
    }
    const bad = ungroundedNumbers(rerank.reasoning, allowed)
    if (bad.length > 0) {
      rejections.push({
        item: 'rerank',
        ref: rerank.dedupe_key,
        reason: `ungrounded_numbers: ${bad.slice(0, 5).join(', ')}`,
      })
      continue
    }
    out.reranks.push({
      dedupe_key: rerank.dedupe_key,
      priority: Math.max(0, Math.min(100, Math.round(rerank.priority))),
      reasoning: rerank.reasoning,
    })
  }

  // (b) + (c) insights: valid criteria, real non-empty segment, grounded prose.
  for (const insight of shape.data.insights.slice(0, 2)) {
    const criteriaParse = smartListCriteriaSchema.safeParse(insight.segment_criteria)
    if (!criteriaParse.success) {
      rejections.push({ item: 'insight', ref: insight.slug, reason: 'invalid_segment_criteria' })
      continue
    }
    const criteria = criteriaParse.data as SmartListCriteria
    if (Object.keys(criteria).length === 0) {
      rejections.push({ item: 'insight', ref: insight.slug, reason: 'empty_segment_criteria' })
      continue
    }

    let resolvedCount = 0
    try {
      resolvedCount = await resolveCount(criteria)
    } catch (e) {
      rejections.push({
        item: 'insight',
        ref: insight.slug,
        reason: `segment_resolution_failed: ${e instanceof Error ? e.message : 'error'}`,
      })
      continue
    }
    if (resolvedCount <= 0) {
      rejections.push({ item: 'insight', ref: insight.slug, reason: 'segment_resolves_to_zero_leads' })
      continue
    }

    const allowedWithCount = new Set(allowed)
    allowedWithCount.add(resolvedCount)
    const bad = ungroundedNumbers(`${insight.title} ${insight.detail}`, allowedWithCount)
    if (bad.length > 0) {
      rejections.push({
        item: 'insight',
        ref: insight.slug,
        reason: `ungrounded_numbers: ${bad.slice(0, 5).join(', ')}`,
      })
      continue
    }

    out.insights.push({
      slug: insight.slug,
      title: insight.title,
      detail: insight.detail,
      criteria,
      resolvedCount,
    })
  }

  return out
}

// ── Run: LLM call + persistence + ai_interactions log ────────────────────────

export type AnalystRunResult = {
  ran: boolean
  reranksApplied: number
  insightsAccepted: number
  insightsExpired: number
  rejections: AnalystRejection[]
  error?: string
}

/**
 * One analyst pass for one org. Assumes the deterministic sync already ran
 * (open rows are fresh). Fails soft: any error is reported in the result, and
 * the deterministic recommendations remain untouched.
 */
export async function runPipelineAnalyst(
  supabase: SupabaseClient,
  orgId: string,
  signals: PipelineSignals,
  nowMs: number = Date.now()
): Promise<AnalystRunResult> {
  const none: AnalystRunResult = {
    ran: false,
    reranksApplied: 0,
    insightsAccepted: 0,
    insightsExpired: 0,
    rejections: [],
  }
  if (!process.env.ANTHROPIC_API_KEY) return { ...none, error: 'ANTHROPIC_API_KEY not set' }

  try {
    // Open rows straight from the table — dedupe_keys the model may rerank.
    const { data: openRows, error: openError } = await supabase
      .from('pipeline_recommendations')
      .select('id, dedupe_key, kind, title, lead_count, expected_value_usd, priority, evidence')
      .eq('organization_id', orgId)
      .eq('status', 'open')
    if (openError) throw new Error(`open rows fetch failed: ${openError.message}`)

    const input = await buildAnalystInput(
      supabase,
      orgId,
      signals,
      (openRows ?? []) as PipelineRecommendationRow[],
      nowMs
    )

    const response = await getAnthropic().messages.create({
      model: ANALYST_MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      system: ANALYST_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(input, null, 2) }],
    })
    const text = response.content[0]?.type === 'text' ? response.content[0].text : ''

    const gated = await gateAnalystOutput(text, input, async (criteria) => {
      const { count } = await resolveSmartListLeads(supabase, orgId, criteria, { countOnly: true })
      return count
    })

    if (gated.rejections.length > 0) {
      console.warn(`[pipeline-analyst] org ${orgId}: rejected ${gated.rejections.length} item(s)`, gated.rejections)
    }

    // Apply reranks: new priority + reasoning appended into the row's evidence.
    const rowByKey = new Map(
      ((openRows ?? []) as Array<{ id: string; dedupe_key: string; evidence: RecommendationEvidence[] }>).map(
        (r) => [r.dedupe_key, r]
      )
    )
    let reranksApplied = 0
    for (const rerank of gated.reranks) {
      const row = rowByKey.get(rerank.dedupe_key)
      if (!row) continue
      const evidence: RecommendationEvidence[] = [
        // Replace any previous analyst reasoning instead of stacking hourly.
        ...(row.evidence ?? []).filter((e) => e.metric !== 'analyst_reasoning'),
        { metric: 'analyst_reasoning', value: rerank.reasoning, source: 'llm_analyst' },
      ]
      const { error: updateError } = await supabase
        .from('pipeline_recommendations')
        .update({ priority: rerank.priority, evidence })
        .eq('id', row.id)
      if (updateError) {
        console.warn(`[pipeline-analyst] rerank persist failed (${rerank.dedupe_key}):`, updateError.message)
        continue
      }
      reranksApplied++
    }

    // Persist accepted insights; expire ones the model stopped producing.
    for (const insight of gated.insights) {
      await upsertAnalystInsight(supabase, orgId, {
        slug: insight.slug,
        title: insight.title,
        detail: insight.detail,
        criteria: insight.criteria,
        leadCount: insight.resolvedCount,
        priority: INSIGHT_DEFAULT_PRIORITY,
        evidence: [
          { metric: 'lead_count', value: insight.resolvedCount, source: 'smart_list_resolver' },
          { metric: 'analyst_reasoning', value: insight.detail, source: 'llm_analyst' },
        ],
      }, nowMs)
    }
    const insightsExpired = await expireMissingAnalystInsights(
      supabase,
      orgId,
      gated.insights.map((i) => i.slug)
    )

    // Cost/usage log — same ai_interactions pattern as the conversation sweep.
    await supabase.from('ai_interactions').insert({
      organization_id: orgId,
      lead_id: null,
      interaction_type: 'other',
      model: ANALYST_MODEL,
      prompt_tokens: response.usage?.input_tokens || 0,
      completion_tokens: response.usage?.output_tokens || 0,
      total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
      output_summary: `Pipeline analyst: ${reranksApplied} rerank(s), ${gated.insights.length} insight(s), ${gated.rejections.length} rejection(s)`,
      success: true,
      metadata: {
        agent: 'pipeline_analyst',
        reranks_applied: reranksApplied,
        insights_accepted: gated.insights.length,
        insights_expired: insightsExpired,
        rejections: gated.rejections,
      },
    })

    return {
      ran: true,
      reranksApplied,
      insightsAccepted: gated.insights.length,
      insightsExpired,
      rejections: gated.rejections,
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'analyst failed'
    console.error(`[pipeline-analyst] org ${orgId} failed:`, message)
    return { ...none, error: message }
  }
}
