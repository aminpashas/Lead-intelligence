/**
 * Bounded negotiation policy (Phase 4). Decides which approved levers the Closer
 * may offer given the lead's price sensitivity — never anything outside the org's
 * configured set, so the agent can negotiate within guardrails instead of a fixed
 * take-it-or-leave-it offer. Pure + testable; the agent prompt consumes the result.
 */

export type NegotiationLever =
  | 'extend_financing_term' // lower monthly via longer term
  | 'phased_treatment' // split treatment into affordable phases
  | 'scheduling_incentive' // book-this-month perk
  | 'in_house_plan' // practice payment plan

export type PriceSensitivity = 'low' | 'medium' | 'high'

export interface NegotiationPolicy {
  /** Levers the org has authorized the agent to offer. */
  enabledLevers: NegotiationLever[]
  /** Advisory floor — agent must not imply discounts beyond this. */
  maxDiscountPct?: number
}

/**
 * Select the levers to offer. Always a subset of the org's enabled levers:
 *   low    → none (no concession needed)
 *   medium → the gentler levers (scheduling incentive, phased treatment)
 *   high   → all enabled levers
 */
export function selectNegotiationLevers(
  policy: NegotiationPolicy,
  sensitivity: PriceSensitivity
): NegotiationLever[] {
  const enabled = new Set(policy.enabledLevers)
  if (sensitivity === 'low') return []

  const wanted: NegotiationLever[] =
    sensitivity === 'high'
      ? ['extend_financing_term', 'phased_treatment', 'scheduling_incentive', 'in_house_plan']
      : ['scheduling_incentive', 'phased_treatment']

  return wanted.filter((l) => enabled.has(l))
}
