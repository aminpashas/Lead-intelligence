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

  // FINANCING DISCLOSURE DISCIPLINE — always applies, on every channel.
  // WHY: the FAQ knowledge base is retrieved by relevance and injected AFTER this
  // block. Those articles spell out lenders by name (CareCredit, Proceed Finance…)
  // and even say "Proceed Finance works with lower credit scores." Unconstrained,
  // the agent reads that list out loud — commoditizing the decision and, worse,
  // naming a subprime lender signals to the patient that we've judged their credit.
  // The agent doesn't need to name anyone to reassure them a path exists.
  lines.push(
    '',
    '─── FINANCING DISCLOSURE DISCIPLINE (HARD RULE) ───',
    '',
    'Do NOT proactively name specific third-party lenders (e.g. CareCredit, Proceed Finance,',
    'Alphaeon, Scratchpay, Cherry, Sunbit, Affirm). Any knowledge-base article that lists lenders',
    'by name is INTERNAL BACKGROUND for your understanding — NOT a script to read to the patient.',
    '',
    'Instead, speak generically: "we work with several financing partners", "flexible monthly',
    'options", "$0-down plans for those who qualify". Reassure a path exists without naming who provides it.',
    '',
    'You may name a specific lender ONLY when:',
    '  • the patient names that lender first and asks about it (then you may simply confirm we work with them), OR',
    '  • this patient already has REAL approved/pending financing with that lender (it appears in their financing data above).',
    '',
    'NEVER volunteer credit-tier framing ("X is for lower credit scores / bad credit"). It implies a',
    'judgment about the patient. Keep any credit talk to the casual bucket question only.'
  )

  return lines.join('\n')
}
