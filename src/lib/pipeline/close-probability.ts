import type { Lead } from '@/types/database'

/**
 * Per-lead close-probability scorer for the pipeline Kanban badges.
 *
 * Standalone + pure (no DB, `nowMs` injected) so it unit-tests without mocks.
 * The factor weights intentionally mirror the Bayesian signals in
 * `src/lib/ai/predictive.ts` (`scoreConversionProbability`) — kept as a separate
 * module so the Kanban can score a single lead cheaply without pulling the whole
 * org-wide insights engine. If the two ever drift, unify them.
 */

const CONVERTED_STATUSES = new Set([
  'contract_signed', 'scheduled', 'in_treatment', 'completed',
])

/** The lead fields the scorer reads. */
export type CloseProbabilityInput = Pick<
  Lead,
  | 'ai_qualification'
  | 'ai_score'
  | 'total_messages_sent'
  | 'total_messages_received'
  | 'financing_interest'
  | 'treatment_value'
  | 'no_show_count'
  | 'created_at'
>

/** Historical base conversion rate from a set of statuses (fallback 0.15). */
export function computeCloseBaseRate(statuses: string[]): number {
  const total = statuses.length
  if (total === 0) return 0.15
  const converted = statuses.filter((s) => CONVERTED_STATUSES.has(s)).length
  return converted / total
}

/** Probability (0-1, 2 d.p.) that a lead closes, given the org base rate. */
export function scoreCloseProbability(
  lead: CloseProbabilityInput,
  baseRate: number,
  nowMs: number
): number {
  let score = baseRate

  // AI qualification tier
  const qualMult: Record<string, number> = { hot: 2.5, warm: 1.5, cold: 0.5, unqualified: 0.2, unscored: 0.8 }
  score *= qualMult[lead.ai_qualification] ?? 1

  // AI score
  if (lead.ai_score >= 70) score *= 1 + (lead.ai_score - 70) / 100
  else if (lead.ai_score > 0 && lead.ai_score < 30) score *= 0.5

  // Engagement (response rate)
  if (lead.total_messages_sent > 0) {
    const responseRate = lead.total_messages_received / lead.total_messages_sent
    if (responseRate > 0.5) score *= 1.4
    else if (responseRate < 0.1 && lead.total_messages_sent > 3) score *= 0.3
  }

  // Financing posture
  if (lead.financing_interest === 'cash_pay') score *= 1.3
  else if (lead.financing_interest === 'financing_needed') score *= 1.1

  // Treatment value assigned (progression)
  if (lead.treatment_value && lead.treatment_value > 0) score *= 1.5

  // No-show history
  if (lead.no_show_count > 0) score *= Math.max(0.3, 1 - lead.no_show_count * 0.25)

  // Freshness decay
  const ageDays = (nowMs - new Date(lead.created_at).getTime()) / (24 * 60 * 60 * 1000)
  if (ageDays > 60) score *= 0.5
  else if (ageDays < 7) score *= 1.2

  const probability = Math.max(0, Math.min(1, score))
  return Math.round(probability * 100) / 100
}
