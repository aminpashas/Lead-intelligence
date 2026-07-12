/**
 * Pipeline Recommendation Store (Workstream C2)
 *
 * Persistence layer for `pipeline_recommendations`. The rules engine
 * (`recommendations.ts`) stays pure; this module owns the DB round-trips:
 *
 *   - `syncRecommendations` — hourly cron writes the engine's output. One OPEN
 *     row per dedupe_key per org: existing open rows are refreshed in place
 *     (counts/EV/priority/evidence drift between runs), rows whose key stopped
 *     being produced are marked 'expired'. Sync only manages origin='rules'
 *     rows — analyst rows have their own lifecycle (see analyst helpers below).
 *   - `listOpenRecommendations` — the Pipeline page reads open, unexpired rows
 *     and maps them back to the engine's `Recommendation` shape so the band
 *     component renders persisted and live-computed recs identically.
 *   - `upsertAnalystInsight` / `expireMissingAnalystInsights` — the LLM
 *     analyst's accepted insights (origin='llm_analyst', dedupe 'analyst:<slug>').
 *
 * Freshness: every upsert stamps `expires_at = now + 24h`. `listOpen…` filters
 * on it, so a row the cron stops refreshing (cron dead, org went inactive)
 * ages out of the UI even before any sweeper marks it 'expired'.
 *
 * Round-tripping: the DB schema stores the C3 descriptor in `execution`; the
 * UI additionally needs the review-surface `action` (segmentName/toStageSlug)
 * and `cta` label, which have no dedicated columns. They ride inside
 * `execution.presentation` and are unpacked by `rowToRecommendation`.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { SmartListCriteria } from '@/types/database'
import type {
  AnyRecommendationKind,
  Recommendation,
  RecommendationAction,
  RecommendationEvidence,
  RecommendationExecution,
} from './recommendations'

/** How long an un-refreshed open row stays visible. The sync cron is hourly,
 *  so 24h means "survives a day of cron failures, then gets out of the way". */
const OPEN_ROW_TTL_MS = 24 * 60 * 60 * 1000

/** The `execution` jsonb as stored: C3 descriptor + UI round-trip payload. */
export type StoredExecution = RecommendationExecution & {
  presentation: { action: RecommendationAction; cta: string }
}

export type PipelineRecommendationRow = {
  id: string
  organization_id: string
  dedupe_key: string
  kind: AnyRecommendationKind
  origin: 'rules' | 'llm_analyst'
  title: string
  detail: string
  segment_criteria: SmartListCriteria
  lead_count: number
  expected_value_usd: number | string | null
  avg_close_probability: number | string | null
  evidence: RecommendationEvidence[]
  execution: StoredExecution
  priority: number
  status: 'open' | 'applied' | 'dismissed' | 'expired' | 'superseded'
  expires_at: string | null
}

/** A persisted rec, shaped for the band component (Recommendation-compatible;
 *  `id` = dedupe_key so apply/dismiss address the same row live recs would). */
export type PersistedRecommendation = Recommendation & {
  recommendationId: string
  origin: 'rules' | 'llm_analyst'
}

export type SyncResult = { inserted: number; refreshed: number; expired: number }

/** The refreshable slice of a row (everything that drifts between engine runs). */
function refreshPayload(rec: Recommendation, expiresAtIso: string) {
  return {
    kind: rec.kind,
    title: rec.title,
    detail: rec.detail,
    segment_criteria: rec.action.criteria,
    lead_count: rec.leadCount,
    expected_value_usd: rec.expectedValueUsd,
    avg_close_probability:
      rec.avgCloseProbability == null
        ? null
        : Math.round(rec.avgCloseProbability * 1000) / 1000, // numeric(4,3)
    evidence: rec.evidence,
    execution: {
      ...rec.execution,
      presentation: { action: rec.action, cta: rec.cta },
    } satisfies StoredExecution,
    priority: rec.priority,
    expires_at: expiresAtIso,
  }
}

/**
 * Upsert the rules engine's current output for one org.
 *
 * - Open rules rows whose dedupe_key is still produced → refreshed in place.
 * - Keys not seen before (or whose previous row was acted on) → inserted.
 * - Open rules rows whose key was NOT produced this run → status 'expired'
 *   (the underlying segment shrank below threshold or the stage changed).
 *
 * Acted-on rows (applied/dismissed) are history and are never touched — a
 * re-fired key simply gets a fresh open row alongside them.
 */
export async function syncRecommendations(
  supabase: SupabaseClient,
  orgId: string,
  recs: Recommendation[],
  nowMs: number = Date.now()
): Promise<SyncResult> {
  const expiresAtIso = new Date(nowMs + OPEN_ROW_TTL_MS).toISOString()

  const { data: openRows, error } = await supabase
    .from('pipeline_recommendations')
    .select('id, dedupe_key')
    .eq('organization_id', orgId)
    .eq('origin', 'rules')
    .eq('status', 'open')
  if (error) throw new Error(`open recommendations fetch failed: ${error.message}`)

  const openByKey = new Map<string, string>(
    (openRows ?? []).map((r: { id: string; dedupe_key: string }) => [r.dedupe_key, r.id])
  )
  const producedKeys = new Set(recs.map((r) => r.id))

  let inserted = 0
  let refreshed = 0

  for (const rec of recs) {
    const payload = refreshPayload(rec, expiresAtIso)
    const existingId = openByKey.get(rec.id)
    if (existingId) {
      const { error: updateError } = await supabase
        .from('pipeline_recommendations')
        .update(payload)
        .eq('id', existingId)
      if (updateError) throw new Error(`recommendation refresh failed (${rec.id}): ${updateError.message}`)
      refreshed++
    } else {
      const { error: insertError } = await supabase
        .from('pipeline_recommendations')
        .insert({
          organization_id: orgId,
          dedupe_key: rec.id,
          origin: 'rules',
          status: 'open',
          ...payload,
        })
      if (insertError) throw new Error(`recommendation insert failed (${rec.id}): ${insertError.message}`)
      inserted++
    }
  }

  const staleIds = (openRows ?? [])
    .filter((r: { dedupe_key: string }) => !producedKeys.has(r.dedupe_key))
    .map((r: { id: string }) => r.id)
  if (staleIds.length > 0) {
    const { error: expireError } = await supabase
      .from('pipeline_recommendations')
      .update({ status: 'expired' })
      .in('id', staleIds)
    if (expireError) throw new Error(`recommendation expire failed: ${expireError.message}`)
  }

  return { inserted, refreshed, expired: staleIds.length }
}

/** Map a DB row back to the band component's Recommendation shape. */
export function rowToRecommendation(row: PipelineRecommendationRow): PersistedRecommendation {
  const presentation = row.execution?.presentation
  // Defensive fallback: a row written without presentation (shouldn't happen)
  // still renders and applies as a review-first SMS segment.
  const action: RecommendationAction = presentation?.action ?? {
    type: 'broadcast',
    channel: 'sms',
    segmentName: row.title.slice(0, 100),
    criteria: row.segment_criteria,
  }
  const execution: RecommendationExecution = {
    version: 1,
    executor: row.execution?.executor ?? 'human_task',
    action: row.execution?.action ?? 'review',
    segment: row.execution?.segment ?? row.segment_criteria,
    guardrails: row.execution?.guardrails ?? {
      requiresConsentGate: true,
      requiresHumanApproval: true,
      maxLeads: 500,
    },
  }
  return {
    id: row.dedupe_key,
    recommendationId: row.id,
    origin: row.origin,
    kind: row.kind,
    priority: row.priority,
    title: row.title,
    detail: row.detail,
    leadCount: row.lead_count,
    cta: presentation?.cta ?? 'Review segment',
    action,
    // numeric columns arrive as strings from PostgREST.
    expectedValueUsd: row.expected_value_usd == null ? null : Number(row.expected_value_usd),
    avgCloseProbability:
      row.avg_close_probability == null ? null : Number(row.avg_close_probability),
    evidence: row.evidence ?? [],
    execution,
  }
}

/**
 * Open, unexpired recommendations for the band, highest priority first.
 * Returns [] on any failure so the page can fall back to live compute.
 */
export async function listOpenRecommendations(
  supabase: SupabaseClient,
  orgId: string,
  nowMs: number = Date.now()
): Promise<PersistedRecommendation[]> {
  try {
    const nowIso = new Date(nowMs).toISOString()
    const { data, error } = await supabase
      .from('pipeline_recommendations')
      .select(
        'id, organization_id, dedupe_key, kind, origin, title, detail, segment_criteria, lead_count, expected_value_usd, avg_close_probability, evidence, execution, priority, status, expires_at'
      )
      .eq('organization_id', orgId)
      .eq('status', 'open')
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .order('priority', { ascending: false })
      .limit(50)
    if (error) throw new Error(error.message)
    return ((data ?? []) as PipelineRecommendationRow[])
      .map(rowToRecommendation)
      .sort(
        (a, b) => b.priority - a.priority || (b.expectedValueUsd ?? 0) - (a.expectedValueUsd ?? 0)
      )
  } catch (e) {
    console.warn(
      '[recommendation-store] listOpenRecommendations failed — falling back to live compute:',
      e instanceof Error ? e.message : e
    )
    return []
  }
}

// ── LLM analyst rows (origin 'llm_analyst') ──────────────────────────────────

export type AnalystInsightUpsert = {
  /** kebab-case identifier from the model; dedupe_key = `analyst:<slug>`. */
  slug: string
  title: string
  detail: string
  criteria: SmartListCriteria
  /** Real, resolver-verified segment size (anti-hallucination gate output). */
  leadCount: number
  evidence: RecommendationEvidence[]
  priority: number
}

export function analystDedupeKey(slug: string): string {
  return `analyst:${slug}`
}

/** Insert or refresh one accepted analyst insight as an open row. */
export async function upsertAnalystInsight(
  supabase: SupabaseClient,
  orgId: string,
  insight: AnalystInsightUpsert,
  nowMs: number = Date.now()
): Promise<void> {
  const dedupeKey = analystDedupeKey(insight.slug)
  const action: RecommendationAction = {
    type: 'broadcast',
    channel: 'sms',
    segmentName: `Insight · ${insight.title}`.slice(0, 100),
    criteria: insight.criteria,
  }
  // Insights are always review-first: a human looks before anything acts.
  const execution: StoredExecution = {
    version: 1,
    executor: 'human_task',
    action: 'review',
    segment: insight.criteria,
    guardrails: { requiresConsentGate: true, requiresHumanApproval: true, maxLeads: 500 },
    presentation: { action, cta: 'Review segment' },
  }
  const payload = {
    kind: 'analyst_insight' as const,
    title: insight.title,
    detail: insight.detail,
    segment_criteria: insight.criteria,
    lead_count: insight.leadCount,
    expected_value_usd: null,
    avg_close_probability: null,
    evidence: insight.evidence,
    execution,
    priority: insight.priority,
    expires_at: new Date(nowMs + OPEN_ROW_TTL_MS).toISOString(),
  }

  const { data: existing, error } = await supabase
    .from('pipeline_recommendations')
    .select('id')
    .eq('organization_id', orgId)
    .eq('dedupe_key', dedupeKey)
    .eq('status', 'open')
    .maybeSingle()
  if (error) throw new Error(`analyst insight lookup failed: ${error.message}`)

  if (existing?.id) {
    const { error: updateError } = await supabase
      .from('pipeline_recommendations')
      .update(payload)
      .eq('id', existing.id)
    if (updateError) throw new Error(`analyst insight refresh failed: ${updateError.message}`)
  } else {
    const { error: insertError } = await supabase
      .from('pipeline_recommendations')
      .insert({
        organization_id: orgId,
        dedupe_key: dedupeKey,
        origin: 'llm_analyst',
        status: 'open',
        ...payload,
      })
    if (insertError) throw new Error(`analyst insight insert failed: ${insertError.message}`)
  }
}

/**
 * Expire open analyst rows the latest SUCCESSFUL analyst run did not re-produce.
 * Only called after a successful run — on LLM failure old insights survive and
 * age out via expires_at instead of being wrongly expired.
 */
export async function expireMissingAnalystInsights(
  supabase: SupabaseClient,
  orgId: string,
  keptSlugs: string[]
): Promise<number> {
  const keptKeys = new Set(keptSlugs.map(analystDedupeKey))
  const { data, error } = await supabase
    .from('pipeline_recommendations')
    .select('id, dedupe_key')
    .eq('organization_id', orgId)
    .eq('origin', 'llm_analyst')
    .eq('status', 'open')
  if (error) throw new Error(`analyst rows fetch failed: ${error.message}`)

  const staleIds = (data ?? [])
    .filter((r: { dedupe_key: string }) => !keptKeys.has(r.dedupe_key))
    .map((r: { id: string }) => r.id)
  if (staleIds.length === 0) return 0

  const { error: expireError } = await supabase
    .from('pipeline_recommendations')
    .update({ status: 'expired' })
    .in('id', staleIds)
  if (expireError) throw new Error(`analyst insight expire failed: ${expireError.message}`)
  return staleIds.length
}
