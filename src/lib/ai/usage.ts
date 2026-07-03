/**
 * AI cost + token observability.
 *
 * Every Claude call should funnel through `recordAiUsage()` so we can:
 *   1. Cap per-lead per-day spend (brief §3.2 — "max_tokens budget per lead per day")
 *   2. Roll up daily AI cost in the analytics dashboard
 *   3. Trace which feature is burning tokens when costs spike
 *
 * Writes to the `ai_usage` table (migration 025).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { estimateAnthropicCents, getAnthropicRate } from '@/lib/billing/pricing'
import { computeBillable } from '@/lib/billing/markup'
import { loadMarkupConfig } from '@/lib/billing/cost-events'

export type AiUsageFeature =
  | 'summarize'
  | 'personalize'
  | 'score'
  | 'sentiment_review'
  | 'compliance_filter'
  | 'post_call_analysis'
  | 'review_response_draft'
  | 'contract_draft'
  | 'command_chat'
  | 'onboarding_interview'

export type RecordAiUsageParams = {
  supabase: SupabaseClient
  organizationId: string
  leadId?: string | null
  feature: AiUsageFeature
  model: string
  tokensIn: number
  tokensOut: number
  /** Anthropic usage.cache_read_input_tokens (billed ≈ 0.1× input). */
  cacheReadTokens?: number
  /** Anthropic usage.cache_creation_input_tokens (billed ≈ 1.25× input). */
  cacheWriteTokens?: number
  durationMs?: number
  succeeded?: boolean
  errorMessage?: string
  metadata?: Record<string, unknown>
}

export async function recordAiUsage(params: RecordAiUsageParams): Promise<void> {
  try {
    const cacheReadTokens = params.cacheReadTokens ?? 0
    const cacheWriteTokens = params.cacheWriteTokens ?? 0

    // Cost comes from the shared provider rate card (single source of truth, correct Opus
    // pricing). An unmapped model books a conservative non-zero cost and is flagged in
    // metadata — never a silent $0 that hides spend.
    const costCents = estimateAnthropicCents({
      model: params.model,
      tokensIn: params.tokensIn,
      tokensOut: params.tokensOut,
      cacheReadTokens,
      cacheWriteTokens,
    })
    const modelKnown = getAnthropicRate(params.model).known

    // Snapshot the re-billed amount using the practice's AI markup so a later markup change
    // never retroactively re-prices historical usage. (Off the response critical path.)
    const markup = await loadMarkupConfig(params.supabase, params.organizationId)
    const { billableCents } = computeBillable(costCents, 'ai', markup)

    await params.supabase.from('ai_usage').insert({
      organization_id: params.organizationId,
      lead_id: params.leadId ?? null,
      feature: params.feature,
      model: params.model,
      tokens_in: params.tokensIn,
      tokens_out: params.tokensOut,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      cost_cents: costCents,
      billable_cents: billableCents,
      duration_ms: params.durationMs ?? null,
      succeeded: params.succeeded ?? true,
      error_message: params.errorMessage ?? null,
      metadata: modelKnown ? (params.metadata ?? {}) : { ...(params.metadata ?? {}), unknown_model: true },
    })
  } catch {
    // Cost logging is observability — never fail the parent call on an insert error.
  }
}

/**
 * Per-lead per-day token budget check. Returns true if the budget is OK.
 * Default cap of 50K tokens/lead/day prevents a runaway loop or compromised lead from
 * draining the Anthropic budget. Tunable per org via organizations.settings.ai_token_cap_per_lead_day.
 */
export async function isUnderDailyBudget(
  supabase: SupabaseClient,
  leadId: string,
  capTokens: number = 50_000
): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data } = await supabase
    .from('ai_usage')
    .select('tokens_in, tokens_out')
    .eq('lead_id', leadId)
    .gte('occurred_at', since)

  if (!data || data.length === 0) return true
  const total = data.reduce(
    (sum: number, row: { tokens_in: number; tokens_out: number }) => sum + row.tokens_in + row.tokens_out,
    0
  )
  return total < capTokens
}
