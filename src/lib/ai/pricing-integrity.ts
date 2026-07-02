/**
 * Pricing Integrity Guardrail
 *
 * WHY THIS EXISTS: LLMs confidently fill any gap you leave. Left unconstrained,
 * the setter improvised "$0 down / $150–200/mo" for a brand-new lead — numbers
 * that appear NOWHERE in our financing math and badly under-quote the real
 * ~$300/mo-per-arch reality. False price expectations poison the consult.
 *
 * The fix is not "make the AI smarter" — it's removing its permission to make up
 * money. Specific figures may ONLY come from real financing data (a lead's
 * financing_context / the financing tool). Otherwise the agent uses the
 * practice-configured range (booking_settings.consult_price_range_text), and
 * only AFTER discovery — never as an opening move.
 *
 * Shared by the setter and closer so the rule is identical everywhere.
 */

export type PricingIntegrityParams = {
  /** booking_settings.consult_price_range_text — the practice's approved range talking point. */
  configuredRange?: string | null
  /**
   * Has enough discovery happened to responsibly talk money? Computed per-lead
   * from qualification state (see isDiscoveryComplete). When false, the agent
   * stays off pricing entirely and steers back to discovery.
   */
  discoveryComplete: boolean
  /**
   * True when the lead has REAL financing figures available (approved amount /
   * lender monthly payment) already injected elsewhere in the prompt. When true,
   * the agent may cite those specific numbers because they are grounded.
   */
  hasRealFinancingData?: boolean
}

export function buildPricingIntegrityBlock(params: PricingIntegrityParams): string {
  const { configuredRange, discoveryComplete, hasRealFinancingData } = params
  const range = configuredRange?.trim()

  const lines: string[] = [
    '═══ PRICING INTEGRITY (MANDATORY — HARD RULE) ═══',
    '',
    'NEVER invent, estimate, or free-form a specific dollar amount, monthly payment,',
    'down payment, interest rate, or term. Made-up numbers set false expectations and',
    'destroy trust at the consult. This overrides any instinct to be helpful with a quick figure.',
    '',
    'Specific figures are allowed ONLY when they come from this patient\'s real financing',
    `data${hasRealFinancingData ? ' (which IS available above — you may cite those exact numbers).' : ' — which is NOT available for this patient, so you have NO specific numbers to give.'}`,
  ]

  if (!discoveryComplete) {
    lines.push(
      '',
      'DISCOVERY IS NOT YET COMPLETE FOR THIS PATIENT.',
      '→ Do NOT discuss cost, monthly payments, financing amounts, or "$0 down" yet.',
      '→ If the patient asks about price now, DON\'T dodge coldly and DON\'T guess. Warmly',
      '  explain you want to get it right: "Great question — every case is a little different,',
      '  so let me learn a couple things first and I\'ll give you real numbers instead of a',
      '  generic guess." Then continue discovery (their goal, timeline, and rough credit).',
      '→ You may reassure them that flexible financing and $0-down options EXIST, without',
      '  attaching any figure to them.'
    )
  } else {
    lines.push(
      '',
      'Discovery is far enough along to set budget expectations — as a RANGE, not a quote.',
      range
        ? `→ Use ONLY the practice\'s approved range: "${range}". Always frame it as an estimate the`
        : '→ No practice range is configured, so DO NOT state numbers. Speak qualitatively (e.g.',
      range
        ? '  free consultation confirms for their specific case. Never narrow it to one precise figure.'
        : '  "a significant investment, with flexible monthly financing") and let the consult set specifics.',
      '→ Emphasize the consult is where they get their exact, personalized plan.'
    )
  }

  return lines.join('\n')
}
