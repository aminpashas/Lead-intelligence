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

export type AiUsageFeature =
  | 'summarize'
  | 'personalize'
  | 'score'
  | 'sentiment_review'
  | 'compliance_filter'
  | 'post_call_analysis'
  | 'review_response_draft'

export type RecordAiUsageParams = {
  supabase: SupabaseClient
  organizationId: string
  leadId?: string | null
  feature: AiUsageFeature
  model: string
  tokensIn: number
  tokensOut: number
  durationMs?: number
  succeeded?: boolean
  errorMessage?: string
  metadata?: Record<string, unknown>
}

/**
 * Approximate Claude pricing in USD-cents per 1K tokens.
 * Sourced from anthropic.com/pricing (as of 2026-04). Update as prices change.
 * Used purely for in-app cost tracking — billing is reconciled against the actual Anthropic invoice.
 */
const PRICE_PER_1K_CENTS: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5':              { in: 0.10, out: 0.50 },
  'claude-3-5-haiku-20241022':     { in: 0.10, out: 0.50 },
  'claude-sonnet-4-5':             { in: 0.30, out: 1.50 },
  'claude-sonnet-4-20250514':      { in: 0.30, out: 1.50 },
  'claude-opus-4':                 { in: 1.50, out: 7.50 },
}

function estimateCostCents(model: string, tokensIn: number, tokensOut: number): number {
  const price = PRICE_PER_1K_CENTS[model]
  if (!price) return 0
  return (tokensIn / 1000) * price.in + (tokensOut / 1000) * price.out
}

export async function recordAiUsage(params: RecordAiUsageParams): Promise<void> {
  try {
    await params.supabase.from('ai_usage').insert({
      organization_id: params.organizationId,
      lead_id: params.leadId ?? null,
      feature: params.feature,
      model: params.model,
      tokens_in: params.tokensIn,
      tokens_out: params.tokensOut,
      cost_cents: estimateCostCents(params.model, params.tokensIn, params.tokensOut),
      duration_ms: params.durationMs ?? null,
      succeeded: params.succeeded ?? true,
      error_message: params.errorMessage ?? null,
      metadata: params.metadata ?? {},
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
