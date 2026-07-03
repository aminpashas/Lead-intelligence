/**
 * Cohort Contrast — the "code decides what's true" half of the learning loop.
 *
 * Pure functions that compare won vs lost cohorts and technique outcomes and
 * emit Findings only when the sample is big enough and the effect is strong
 * enough. The LLM never sees raw data — only Findings that survive these
 * gates — so small-sample hallucinated patterns can't become rules.
 */

import type { LearningJourneyStats, LearningOutcome } from '@/types/database'

export type Finding = {
  /** Stable dedupe key — one rule per finding, ever. */
  key: string
  kind: 'technique' | 'journey_feature'
  headline: string
  detail: string
  stats: Record<string, number>
  /** Rules can only fix what the prompt controls. Latency/routing findings are
   *  surfaced for humans instead of being turned into rules. */
  prompt_fixable: boolean
}

// Gates. Deliberately conservative: a rule injected into every practice's
// prompt is expensive to be wrong about.
const MIN_COHORT = 20
const MIN_TECHNIQUE_USES = 30
const MIN_Z = 2 // ~95% two-sided

export const POSITIVE_OUTCOMES: LearningOutcome[] = ['booked', 'showed', 'contract_signed']
export const NEGATIVE_OUTCOMES: LearningOutcome[] = ['no_show', 'lost']

/** Two-proportion z-test statistic. */
export function twoProportionZ(p1: number, n1: number, p2: number, n2: number): number {
  if (n1 === 0 || n2 === 0) return 0
  const p = (p1 * n1 + p2 * n2) / (n1 + n2)
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
  if (se === 0) return 0
  return (p1 - p2) / se
}

export type TechniqueOutcomeRow = {
  technique_id: string
  actual_effectiveness: string
  agent_type: string | null
}

/**
 * For each technique: is its real-world effective-rate significantly different
 * from all other techniques combined?
 */
export function contrastTechniques(rows: TechniqueOutcomeRow[]): Finding[] {
  const scored = rows.filter((r) => r.actual_effectiveness !== 'too_early')
  const byTechnique = new Map<string, { effective: number; total: number }>()
  let globalEffective = 0

  for (const r of scored) {
    const entry = byTechnique.get(r.technique_id) || { effective: 0, total: 0 }
    entry.total++
    if (r.actual_effectiveness === 'effective') {
      entry.effective++
      globalEffective++
    }
    byTechnique.set(r.technique_id, entry)
  }

  const findings: Finding[] = []
  for (const [techniqueId, { effective, total }] of byTechnique) {
    if (total < MIN_TECHNIQUE_USES) continue
    const restTotal = scored.length - total
    if (restTotal < MIN_COHORT) continue
    const rate = effective / total
    const restRate = (globalEffective - effective) / restTotal
    const z = twoProportionZ(rate, total, restRate, restTotal)
    if (Math.abs(z) < MIN_Z) continue

    const direction = z > 0 ? 'outperforms' : 'underperforms'
    findings.push({
      key: `technique:${techniqueId}:${direction}`,
      kind: 'technique',
      headline: `Technique "${techniqueId}" ${direction} (${Math.round(rate * 100)}% vs ${Math.round(restRate * 100)}% effective)`,
      detail:
        `Across ${total} real uses, "${techniqueId}" led to a booked appointment or reply ` +
        `${Math.round(rate * 100)}% of the time, vs ${Math.round(restRate * 100)}% for all other ` +
        `techniques (${restTotal} uses). z=${z.toFixed(2)}. Outcomes are from the nightly ` +
        `technique-feedback backfill, not model predictions.`,
      stats: { rate, rest_rate: restRate, n: total, rest_n: restTotal, z },
      prompt_fixable: true,
    })
  }
  return findings
}

export type EpisodeForContrast = {
  outcome: LearningOutcome
  journey_stats: LearningJourneyStats
}

type NumericFeature = {
  key: keyof Pick<
    LearningJourneyStats,
    'first_response_minutes' | 'median_response_minutes' | 'inbound_count' | 'ai_share' | 'days_span'
  >
  label: string
  prompt_fixable: boolean
}

// Which journey features to contrast, and whether a prompt rule can act on
// them. Response latency is an ops/code problem — the agent can't send faster
// by being told to.
const FEATURES: NumericFeature[] = [
  { key: 'first_response_minutes', label: 'first response time (minutes)', prompt_fixable: false },
  { key: 'median_response_minutes', label: 'median response time (minutes)', prompt_fixable: false },
  { key: 'inbound_count', label: 'patient replies in journey', prompt_fixable: true },
  { key: 'ai_share', label: 'share of outbound sent by AI', prompt_fixable: false },
  { key: 'days_span', label: 'journey length (days)', prompt_fixable: true },
]

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Compare journey features between won and lost episode cohorts. Uses median
 * comparison with a relative-delta gate rather than a t-test — journey
 * features are heavy-tailed and medians resist outliers.
 */
export function contrastEpisodeFeatures(episodes: EpisodeForContrast[]): Finding[] {
  const won = episodes.filter((e) => POSITIVE_OUTCOMES.includes(e.outcome))
  const lost = episodes.filter((e) => NEGATIVE_OUTCOMES.includes(e.outcome))
  if (won.length < MIN_COHORT || lost.length < MIN_COHORT) return []

  const findings: Finding[] = []
  for (const feature of FEATURES) {
    const wonVals = won
      .map((e) => e.journey_stats?.[feature.key])
      .filter((v): v is number => typeof v === 'number')
    const lostVals = lost
      .map((e) => e.journey_stats?.[feature.key])
      .filter((v): v is number => typeof v === 'number')
    if (wonVals.length < MIN_COHORT || lostVals.length < MIN_COHORT) continue

    const wonMed = median(wonVals)!
    const lostMed = median(lostVals)!
    const base = Math.max(Math.abs(wonMed), Math.abs(lostMed), 1e-9)
    const relDelta = Math.abs(wonMed - lostMed) / base
    if (relDelta < 0.3) continue // require a ≥30% median gap

    findings.push({
      key: `feature:${String(feature.key)}`,
      kind: 'journey_feature',
      headline: `Won journeys differ on ${feature.label}: median ${round2(wonMed)} vs ${round2(lostMed)} in lost journeys`,
      detail:
        `Across ${wonVals.length} won episodes (booked/showed/signed) and ${lostVals.length} ` +
        `lost episodes (no-show/lost), median ${feature.label} was ${round2(wonMed)} vs ` +
        `${round2(lostMed)} (${Math.round(relDelta * 100)}% gap).`,
      stats: {
        won_median: wonMed,
        lost_median: lostMed,
        won_n: wonVals.length,
        lost_n: lostVals.length,
        rel_delta: relDelta,
      },
      prompt_fixable: feature.prompt_fixable,
    })
  }
  return findings
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
