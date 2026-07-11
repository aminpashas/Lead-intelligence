import type { Lead, LeadStatus } from '@/types/database'
import type { EnrichmentSummary } from '@/lib/enrichment/types'

/**
 * Single source of truth for the close-probability feature vector.
 *
 * Both the weekly calibration cron (training) and the live scorer (inference)
 * MUST build features through `buildFeatureVector` — a train/serve skew here
 * silently invalidates every stored model. All features are engineered to the
 * 0..1 range so the logistic fit is well-conditioned without a scaler.
 *
 * Bump FEATURE_SCHEMA_VERSION whenever the feature set or any encoding changes;
 * models are stored with the version they were fitted under, and a model fitted
 * on schema N must never be evaluated with vectors from schema N+1.
 */

export const FEATURE_SCHEMA_VERSION = 1

/** Canonical feature order — training matrices are built in this order. */
export const featureNames = [
  'ai_score',
  'qual_hot',
  'qual_warm',
  'qual_cold',
  'response_rate',
  'financing_cash_pay',
  'financing_needed',
  'has_treatment_value',
  'no_show',
  'lead_age',
  'intent_ready_to_book',
  'identity_confidence',
  'source_paid',
] as const

export type FeatureName = (typeof featureNames)[number]

/** The lead fields the feature builder reads (a strict subset of Lead). */
export type FeatureInput = Pick<
  Lead,
  | 'ai_score'
  | 'ai_qualification'
  | 'total_messages_sent'
  | 'total_messages_received'
  | 'financing_interest'
  | 'treatment_value'
  | 'no_show_count'
  | 'created_at'
  | 'conversation_intent'
  | 'enrichment_score'
  | 'gclid'
  | 'fbclid'
  | 'utm_medium'
>

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))

/**
 * Build the model input vector for one lead. `enrichment` (a computed
 * EnrichmentSummary) is preferred for identity confidence when the caller has
 * it; otherwise `leads.enrichment_score` stands in, and a never-enriched lead
 * gets a neutral 0.5 so missing data is not read as low-quality identity.
 */
export function buildFeatureVector(
  lead: FeatureInput,
  enrichment?: Pick<EnrichmentSummary, 'identity_confidence'> | null,
  nowMs: number = Date.now()
): Record<FeatureName, number> {
  // Response rate: replies per outbound message. max(sent, 1) keeps the
  // never-messaged lead at 0 instead of dividing by zero.
  const responseRate = clamp01(
    (lead.total_messages_received ?? 0) / Math.max(lead.total_messages_sent ?? 0, 1)
  )

  // Age bucket: log-scaled days so the difference between day 1 and day 10
  // matters more than day 300 vs day 310; saturates at ~1 year.
  const ageDays = Math.max(0, (nowMs - new Date(lead.created_at).getTime()) / 86_400_000)
  const leadAge = clamp01(Math.log(1 + ageDays) / Math.log(365))

  // Identity confidence: enrichment summary when supplied, else the persisted
  // leads.enrichment_score, else a neutral prior (0 would conflate "unknown"
  // with "confirmed bad identity").
  let identityConfidence = 0.5
  if (enrichment && typeof enrichment.identity_confidence === 'number') {
    identityConfidence = clamp01(enrichment.identity_confidence / 100)
  } else if ((lead.enrichment_score ?? 0) > 0) {
    identityConfidence = clamp01(lead.enrichment_score / 100)
  }

  // Paid-source flag: click ids are the reliable signal (gclid/fbclid are only
  // ever set on paid clicks); utm_medium catches paid traffic that lost its
  // click id. utm_source alone is too noisy to use.
  const sourcePaid =
    lead.gclid != null ||
    lead.fbclid != null ||
    /^(cpc|ppc|paid|paid[-_]social)$/i.test(lead.utm_medium ?? '')
      ? 1
      : 0

  return {
    ai_score: clamp01((lead.ai_score ?? 0) / 100),
    // One-hot qualification; 'unscored' + 'unqualified' form the baseline.
    qual_hot: lead.ai_qualification === 'hot' ? 1 : 0,
    qual_warm: lead.ai_qualification === 'warm' ? 1 : 0,
    qual_cold: lead.ai_qualification === 'cold' ? 1 : 0,
    response_rate: responseRate,
    financing_cash_pay: lead.financing_interest === 'cash_pay' ? 1 : 0,
    financing_needed: lead.financing_interest === 'financing_needed' ? 1 : 0,
    has_treatment_value: lead.treatment_value && lead.treatment_value > 0 ? 1 : 0,
    no_show: clamp01(Math.min(lead.no_show_count ?? 0, 3) / 3),
    lead_age: leadAge,
    intent_ready_to_book: lead.conversation_intent === 'ready_to_book' ? 1 : 0,
    identity_confidence: identityConfidence,
    source_paid: sourcePaid,
  }
}

/** Record → ordered array in `featureNames` order (training matrix rows). */
export function toFeatureArray(features: Record<FeatureName, number>): number[] {
  return featureNames.map((name) => features[name])
}

// ── Training-cohort labeling ────────────────────────────────────────────────

/** Statuses that count as a converted (won) outcome — mirrors close-probability.ts. */
const CONVERTED_STATUSES: ReadonlySet<LeadStatus> = new Set([
  'contract_signed', 'scheduled', 'in_treatment', 'completed',
])

const TERMINAL_NEGATIVE_STATUSES: ReadonlySet<LeadStatus> = new Set(['lost', 'disqualified'])

/** A lead untouched this long with no won/lost outcome counts as a negative. */
export const STALE_NEGATIVE_DAYS = 90

/** The lead fields outcome labeling reads. */
export type OutcomeLabelInput = Pick<Lead, 'converted_at' | 'status' | 'created_at' | 'last_contacted_at'>

/**
 * Cohort label for calibration training AND backtests — keep both on this one
 * helper so an offline evaluation is measured against the same ground truth the
 * cron trained on.
 *
 * Returns 1 (converted), 0 (lost/disqualified, or stale — no touch in
 * STALE_NEGATIVE_DAYS), or null (outcome still undetermined → excluded).
 */
export function labelLeadOutcome(lead: OutcomeLabelInput, nowMs: number): 0 | 1 | null {
  if (lead.converted_at != null || CONVERTED_STATUSES.has(lead.status)) return 1
  if (TERMINAL_NEGATIVE_STATUSES.has(lead.status)) return 0

  const lastActivityMs = Math.max(
    new Date(lead.created_at).getTime(),
    lead.last_contacted_at ? new Date(lead.last_contacted_at).getTime() : 0
  )
  if (nowMs - lastActivityMs > STALE_NEGATIVE_DAYS * 86_400_000) return 0

  return null
}
