/**
 * Financing Calculator Engine
 *
 * Builds complete financial breakdowns for patients:
 * Treatment cost → deductions (insurance, cash, HSA) → amount to finance →
 * payment scenarios across all active lenders → recommendation.
 */

import type { LenderSlug, PaymentEstimate } from './types'
import type { BudgetRange } from '@/types/database'
import { LENDER_RATES, getApplicableTiers, type RateTier } from './rates'

// ── Core Types ─────────────────────────────────────────────

export type FinancingDeductions = {
  insurance_estimate: number
  patient_cash: number
  hsa_fsa: number
  other_credits: number
  total_deductions: number
}

export type AmortizationRow = {
  month: number
  payment: number
  principal: number
  interest: number
  balance: number
  is_promo: boolean
}

export type BiweeklyDetails = {
  biweekly_payment: number
  biweekly_total_paid: number
  biweekly_total_interest: number
  biweekly_interest_saved: number
  biweekly_months_saved: number
  biweekly_payoff_months: number
}

export type ExtraPaymentSavings = {
  extra_per_month: number
  new_total_interest: number
  interest_saved: number
  new_payoff_months: number
  months_saved: number
}

export type PaymentScenario = {
  lender_slug: LenderSlug
  lender_name: string
  tier_label: string
  financed_amount: number
  apr: number
  term_months: number
  promo_months: number
  monthly_payment: number
  total_paid: number
  total_interest: number
  effective_apr: number
  biweekly: BiweeklyDetails
  extra_payment_scenarios: ExtraPaymentSavings[]
}

export type SavingsTip = {
  tip: string
  savings_amount: number
  type: 'biweekly' | 'extra_payment' | 'lump_sum' | 'refinance' | 'promo'
}

export type LenderOptionGroup = {
  lender_slug: LenderSlug
  lender_name: string
  approval_rate_estimate: number
  recommended_tier: string
  terms: PaymentScenario[]
}

export type FinancingBreakdown = {
  treatment_value: number
  deductions: FinancingDeductions
  amount_to_finance: number
  scenarios: PaymentScenario[]
  lender_options: LenderOptionGroup[]
  recommendation: {
    best_overall: PaymentScenario | null
    lowest_monthly: PaymentScenario | null
    lowest_total_cost: PaymentScenario | null
    shortest_payoff: PaymentScenario | null
    zero_interest: PaymentScenario | null
    best_biweekly_savings: PaymentScenario | null
  }
  savings_tips: SavingsTip[]
  generated_at: string
}

export type BreakdownOptions = {
  treatment_value: number
  insurance_estimate?: number
  patient_cash?: number
  hsa_fsa?: number
  other_credits?: number
  budget_range?: BudgetRange | null
  has_dental_insurance?: boolean | null
  active_lenders?: LenderSlug[]
}

// ── Main Calculator ────────────────────────────────────────

/**
 * Build a complete financing breakdown for a patient.
 */
export function buildFinancingBreakdown(options: BreakdownOptions): FinancingBreakdown {
  const {
    treatment_value,
    insurance_estimate,
    patient_cash,
    hsa_fsa = 0,
    other_credits = 0,
    budget_range,
    has_dental_insurance,
    active_lenders,
  } = options

  // Calculate deductions
  const insuranceAmt = insurance_estimate ?? estimateInsuranceCoverage(treatment_value, has_dental_insurance)
  const cashAmt = patient_cash ?? budgetRangeToDownPayment(budget_range)

  const deductions: FinancingDeductions = {
    insurance_estimate: insuranceAmt,
    patient_cash: cashAmt,
    hsa_fsa: hsa_fsa,
    other_credits: other_credits,
    total_deductions: insuranceAmt + cashAmt + hsa_fsa + other_credits,
  }

  const amountToFinance = Math.max(0, treatment_value - deductions.total_deductions)

  // Generate scenarios from all lenders
  const lendersToUse = active_lenders || (Object.keys(LENDER_RATES) as LenderSlug[])
  const scenarios: PaymentScenario[] = []

  for (const slug of lendersToUse) {
    const tiers = getApplicableTiers(slug, amountToFinance)
    const config = LENDER_RATES[slug]
    if (!config) continue

    for (const tier of tiers) {
      const scenario = calculateScenario(slug, config.name, tier, amountToFinance)
      if (scenario) scenarios.push(scenario)
    }
  }

  // Sort by monthly payment ascending
  scenarios.sort((a, b) => a.monthly_payment - b.monthly_payment)

  // Group by lender for the option matrix
  const lenderGroups = new Map<string, PaymentScenario[]>()
  for (const s of scenarios) {
    const group = lenderGroups.get(s.lender_slug) || []
    group.push(s)
    lenderGroups.set(s.lender_slug, group)
  }

  const lenderOptions: LenderOptionGroup[] = Array.from(lenderGroups.entries()).map(([slug, terms]) => {
    const config = LENDER_RATES[slug as LenderSlug]
    // Recommend: 0% promo if available, otherwise lowest total cost
    const promo = terms.find(t => t.promo_months > 0 && t.term_months >= 6)
    const cheapest = terms.reduce((a, b) => a.total_paid < b.total_paid ? a : b)
    const recommended = promo || cheapest

    return {
      lender_slug: slug as LenderSlug,
      lender_name: config?.name || slug,
      approval_rate_estimate: config?.approval_rate_estimate || 50,
      recommended_tier: recommended.tier_label,
      terms: terms.sort((a, b) => a.term_months - b.term_months),
    }
  })

  // Sort lender groups by best monthly payment
  lenderOptions.sort((a, b) => {
    const aMin = Math.min(...a.terms.map(t => t.monthly_payment))
    const bMin = Math.min(...b.terms.map(t => t.monthly_payment))
    return aMin - bMin
  })

  // Build recommendations
  const nonZeroScenarios = scenarios.filter(s => s.monthly_payment > 0)
  const zeroInterest = scenarios.find(s => s.total_interest === 0 && s.term_months >= 6)
  const bestBiweeklySavings = nonZeroScenarios.length > 0
    ? nonZeroScenarios.reduce((a, b) => a.biweekly.biweekly_interest_saved > b.biweekly.biweekly_interest_saved ? a : b)
    : null

  // Best overall: composite score (affordability + total cost + term)
  let bestOverall: PaymentScenario | null = null
  if (nonZeroScenarios.length > 0) {
    const maxMonthly = Math.max(...nonZeroScenarios.map(s => s.monthly_payment))
    const maxTotal = Math.max(...nonZeroScenarios.map(s => s.total_paid))
    const maxTerm = Math.max(...nonZeroScenarios.map(s => s.term_months))

    bestOverall = nonZeroScenarios.reduce((best, s) => {
      const affordScore = maxMonthly > 0 ? (1 - s.monthly_payment / maxMonthly) * 40 : 0
      const costScore = maxTotal > 0 ? (1 - s.total_paid / maxTotal) * 35 : 0
      const termScore = maxTerm > 0 ? (1 - s.term_months / maxTerm) * 25 : 0
      const score = affordScore + costScore + termScore

      const bestAfford = maxMonthly > 0 ? (1 - best.monthly_payment / maxMonthly) * 40 : 0
      const bestCost = maxTotal > 0 ? (1 - best.total_paid / maxTotal) * 35 : 0
      const bestTerm = maxTerm > 0 ? (1 - best.term_months / maxTerm) * 25 : 0
      const bestScore = bestAfford + bestCost + bestTerm

      return score > bestScore ? s : best
    })
  }

  const recommendation = {
    best_overall: bestOverall,
    lowest_monthly: nonZeroScenarios.length > 0
      ? nonZeroScenarios.reduce((a, b) => a.monthly_payment < b.monthly_payment ? a : b)
      : null,
    lowest_total_cost: nonZeroScenarios.length > 0
      ? nonZeroScenarios.reduce((a, b) => a.total_paid < b.total_paid ? a : b)
      : null,
    shortest_payoff: nonZeroScenarios.length > 0
      ? nonZeroScenarios.reduce((a, b) => a.term_months < b.term_months ? a : b)
      : null,
    zero_interest: zeroInterest || null,
    best_biweekly_savings: bestBiweeklySavings,
  }

  // Generate savings tips
  const savingsTips = generateSavingsTips(scenarios, amountToFinance)

  return {
    treatment_value,
    deductions,
    amount_to_finance: amountToFinance,
    scenarios,
    lender_options: lenderOptions,
    recommendation,
    savings_tips: savingsTips,
    generated_at: new Date().toISOString(),
  }
}

// ── Amortization ───────────────────────────────────────────

/**
 * Generate a month-by-month amortization schedule.
 * Handles promotional 0% periods followed by standard APR.
 */
export function generateAmortizationSchedule(
  principal: number,
  apr: number,
  termMonths: number,
  promoMonths: number = 0
): AmortizationRow[] {
  const schedule: AmortizationRow[] = []
  let balance = principal

  if (promoMonths > 0 && promoMonths >= termMonths) {
    // Entire term is promotional (0% APR)
    const monthlyPayment = Math.ceil(principal / termMonths * 100) / 100
    for (let m = 1; m <= termMonths; m++) {
      const isLast = m === termMonths
      const payment = isLast ? balance : monthlyPayment
      balance = Math.max(0, balance - payment)
      schedule.push({
        month: m,
        payment: Math.round(payment * 100) / 100,
        principal: Math.round(payment * 100) / 100,
        interest: 0,
        balance: Math.round(balance * 100) / 100,
        is_promo: true,
      })
    }
    return schedule
  }

  // Calculate the standard monthly payment for the non-promo portion
  const remainingMonths = termMonths - promoMonths
  const monthlyRate = apr / 100 / 12

  // During promo period: equal payments, no interest
  if (promoMonths > 0) {
    // During promo: pay principal only at the rate needed to pay off in full term
    const promoPayment = Math.ceil(principal / termMonths * 100) / 100
    for (let m = 1; m <= promoMonths; m++) {
      const payment = promoPayment
      balance = Math.max(0, balance - payment)
      schedule.push({
        month: m,
        payment: Math.round(payment * 100) / 100,
        principal: Math.round(payment * 100) / 100,
        interest: 0,
        balance: Math.round(balance * 100) / 100,
        is_promo: true,
      })
    }
  }

  // Standard amortization for remaining balance
  if (balance > 0 && remainingMonths > 0 && monthlyRate > 0) {
    const standardPayment = (balance * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -remainingMonths))

    for (let m = promoMonths + 1; m <= termMonths; m++) {
      const interest = balance * monthlyRate
      const isLast = m === termMonths
      const payment = isLast ? balance + interest : standardPayment
      const principalPart = payment - interest
      balance = Math.max(0, balance - principalPart)

      schedule.push({
        month: m,
        payment: Math.round(payment * 100) / 100,
        principal: Math.round(principalPart * 100) / 100,
        interest: Math.round(interest * 100) / 100,
        balance: Math.round(balance * 100) / 100,
        is_promo: false,
      })
    }
  } else if (balance > 0 && remainingMonths > 0) {
    // 0% APR for remaining months
    const payment = Math.ceil(balance / remainingMonths * 100) / 100
    for (let m = promoMonths + 1; m <= termMonths; m++) {
      const isLast = m === termMonths
      const actualPayment = isLast ? balance : payment
      balance = Math.max(0, balance - actualPayment)
      schedule.push({
        month: m,
        payment: Math.round(actualPayment * 100) / 100,
        principal: Math.round(actualPayment * 100) / 100,
        interest: 0,
        balance: Math.round(balance * 100) / 100,
        is_promo: false,
      })
    }
  }

  return schedule
}

// ── Helpers ────────────────────────────────────────────────

function calculateScenario(
  slug: LenderSlug,
  lenderName: string,
  tier: RateTier,
  amount: number
): PaymentScenario | null {
  if (amount <= 0) return null

  const promoMonths = tier.promo_months || 0
  const schedule = generateAmortizationSchedule(amount, tier.apr, tier.term_months, promoMonths)

  if (schedule.length === 0) return null

  const totalPaid = schedule.reduce((sum, row) => sum + row.payment, 0)
  const totalInterest = schedule.reduce((sum, row) => sum + row.interest, 0)
  const monthlyPayment = schedule[0]?.payment || 0

  // Effective APR accounts for promo periods
  const effectiveApr = amount > 0 && tier.term_months > 0
    ? ((totalInterest / amount) / (tier.term_months / 12)) * 100
    : 0

  // Bi-weekly calculation: 26 payments/year = 13 monthly equivalents
  const biweekly = calculateBiweeklyDetails(amount, tier.apr, tier.term_months, promoMonths, totalPaid, totalInterest)

  // Extra payment scenarios: +$50, +$100, +$200/month
  const extraPaymentScenarios = [50, 100, 200]
    .map(extra => calculateExtraPaymentSavings(amount, tier.apr, tier.term_months, promoMonths, monthlyPayment, extra))
    .filter((s): s is ExtraPaymentSavings => s !== null)

  return {
    lender_slug: slug,
    lender_name: lenderName,
    tier_label: tier.label,
    financed_amount: amount,
    apr: tier.apr,
    term_months: tier.term_months,
    promo_months: promoMonths,
    monthly_payment: Math.round(monthlyPayment * 100) / 100,
    total_paid: Math.round(totalPaid * 100) / 100,
    total_interest: Math.round(totalInterest * 100) / 100,
    effective_apr: Math.round(effectiveApr * 100) / 100,
    biweekly,
    extra_payment_scenarios: extraPaymentScenarios,
  }
}

/**
 * Calculate bi-weekly payment details and interest savings.
 * Bi-weekly = 26 payments/year = equivalent of 13 monthly payments.
 * The extra "month" per year goes directly to principal, accelerating payoff.
 */
function calculateBiweeklyDetails(
  principal: number,
  apr: number,
  termMonths: number,
  promoMonths: number,
  monthlyTotalPaid: number,
  monthlyTotalInterest: number
): BiweeklyDetails {
  if (apr === 0 || principal <= 0) {
    const biweeklyPayment = Math.round(principal / termMonths / 2 * 100) / 100
    return {
      biweekly_payment: biweeklyPayment,
      biweekly_total_paid: Math.round(principal * 100) / 100,
      biweekly_total_interest: 0,
      biweekly_interest_saved: 0,
      biweekly_months_saved: 0,
      biweekly_payoff_months: termMonths,
    }
  }

  // Simulate bi-weekly payments (half of monthly, 26x/year)
  const biweeklyRate = apr / 100 / 26
  const monthlyRate = apr / 100 / 12

  // Standard monthly payment (skip promo period for simplicity)
  const effectivePrincipal = promoMonths > 0
    ? principal * (1 - promoMonths / termMonths) // rough estimate of remaining after promo
    : principal
  const effectiveMonths = termMonths - promoMonths

  if (effectiveMonths <= 0 || effectivePrincipal <= 0) {
    return {
      biweekly_payment: Math.round(principal / termMonths / 2 * 100) / 100,
      biweekly_total_paid: Math.round(principal * 100) / 100,
      biweekly_total_interest: 0,
      biweekly_interest_saved: 0,
      biweekly_months_saved: 0,
      biweekly_payoff_months: termMonths,
    }
  }

  const monthlyPayment = (effectivePrincipal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -effectiveMonths))
  const biweeklyPayment = monthlyPayment / 2

  // Simulate bi-weekly amortization
  let balance = effectivePrincipal
  let totalInterest = 0
  let periods = 0
  const maxPeriods = effectiveMonths * 3 // safety cap

  while (balance > 0.01 && periods < maxPeriods) {
    const interest = balance * biweeklyRate
    const principalPart = Math.min(biweeklyPayment - interest, balance)
    if (principalPart <= 0) break
    balance -= principalPart
    totalInterest += interest
    periods++
  }

  const biweeklyPayoffMonths = Math.round(periods / 26 * 12) + promoMonths
  const promoInterest = 0 // promo period has 0 interest
  const biweeklyTotalInterest = promoInterest + totalInterest
  const biweeklyTotalPaid = principal + biweeklyTotalInterest

  return {
    biweekly_payment: Math.round(biweeklyPayment * 100) / 100,
    biweekly_total_paid: Math.round(biweeklyTotalPaid * 100) / 100,
    biweekly_total_interest: Math.round(biweeklyTotalInterest * 100) / 100,
    biweekly_interest_saved: Math.round(Math.max(0, monthlyTotalInterest - biweeklyTotalInterest) * 100) / 100,
    biweekly_months_saved: Math.max(0, termMonths - biweeklyPayoffMonths),
    biweekly_payoff_months: biweeklyPayoffMonths,
  }
}

/**
 * Calculate savings from making extra monthly payments.
 */
function calculateExtraPaymentSavings(
  principal: number,
  apr: number,
  termMonths: number,
  promoMonths: number,
  baseMonthlyPayment: number,
  extraPerMonth: number
): ExtraPaymentSavings | null {
  if (apr === 0 || principal <= 0 || extraPerMonth <= 0) return null

  const monthlyRate = apr / 100 / 12
  const newPayment = baseMonthlyPayment + extraPerMonth

  // Simulate accelerated payoff
  let balance = principal
  let totalInterest = 0
  let months = 0

  // Skip promo period (no interest)
  if (promoMonths > 0) {
    const promoPayment = Math.ceil(principal / termMonths * 100) / 100
    for (let m = 0; m < promoMonths && balance > 0; m++) {
      balance -= promoPayment
      months++
    }
    balance = Math.max(0, balance)
  }

  // Standard amortization with extra payment
  while (balance > 0.01 && months < termMonths * 2) {
    const interest = balance * monthlyRate
    const principalPart = newPayment - interest
    if (principalPart <= 0) break
    balance = Math.max(0, balance - principalPart)
    totalInterest += interest
    months++
  }

  // Compare against original
  const originalSchedule = generateAmortizationSchedule(principal, apr, termMonths, promoMonths)
  const originalInterest = originalSchedule.reduce((sum, r) => sum + r.interest, 0)

  const interestSaved = originalInterest - totalInterest
  const monthsSaved = termMonths - months

  if (interestSaved <= 0 && monthsSaved <= 0) return null

  return {
    extra_per_month: extraPerMonth,
    new_total_interest: Math.round(totalInterest * 100) / 100,
    interest_saved: Math.round(Math.max(0, interestSaved) * 100) / 100,
    new_payoff_months: months,
    months_saved: Math.max(0, monthsSaved),
  }
}

/**
 * Generate actionable savings tips based on the scenarios.
 */
function generateSavingsTips(
  scenarios: PaymentScenario[],
  amountToFinance: number
): SavingsTip[] {
  const tips: SavingsTip[] = []

  // Tip 1: Bi-weekly payments
  const bestBiweekly = scenarios
    .filter(s => s.biweekly.biweekly_interest_saved > 100)
    .sort((a, b) => b.biweekly.biweekly_interest_saved - a.biweekly.biweekly_interest_saved)[0]

  if (bestBiweekly) {
    tips.push({
      tip: `Switch to bi-weekly payments to save $${bestBiweekly.biweekly.biweekly_interest_saved.toLocaleString()} in interest and pay off ${bestBiweekly.biweekly.biweekly_months_saved} months early (${bestBiweekly.lender_name} ${bestBiweekly.term_months}mo plan)`,
      savings_amount: bestBiweekly.biweekly.biweekly_interest_saved,
      type: 'biweekly',
    })
  }

  // Tip 2: Extra $100/month
  const extraHundred = scenarios
    .flatMap(s => s.extra_payment_scenarios.filter(e => e.extra_per_month === 100))
    .sort((a, b) => b.interest_saved - a.interest_saved)[0]

  if (extraHundred && extraHundred.interest_saved > 50) {
    tips.push({
      tip: `Add $100/month extra to save $${extraHundred.interest_saved.toLocaleString()} in interest and finish ${extraHundred.months_saved} months sooner`,
      savings_amount: extraHundred.interest_saved,
      type: 'extra_payment',
    })
  }

  // Tip 3: 0% promo if available
  const promo = scenarios.find(s => s.promo_months > 0 && s.total_interest === 0)
  if (promo) {
    const regularEquiv = scenarios.find(s =>
      s.lender_slug === promo.lender_slug && s.promo_months === 0 && s.term_months >= promo.term_months
    )
    const savings = regularEquiv ? regularEquiv.total_interest : amountToFinance * 0.15
    tips.push({
      tip: `Use ${promo.lender_name}'s ${promo.promo_months}-month 0% APR promotion to pay $0 in interest — save $${Math.round(savings).toLocaleString()} vs standard rates`,
      savings_amount: Math.round(savings),
      type: 'promo',
    })
  }

  // Tip 4: Tax refund lump sum
  if (amountToFinance > 10000) {
    const taxRefundSavings = Math.round(amountToFinance * 0.03) // rough estimate
    tips.push({
      tip: `Apply your tax refund (~$3,000) as a lump-sum payment to reduce your balance by 10% and save roughly $${taxRefundSavings.toLocaleString()} in interest`,
      savings_amount: taxRefundSavings,
      type: 'lump_sum',
    })
  }

  return tips.sort((a, b) => b.savings_amount - a.savings_amount)
}

/**
 * Rough insurance estimate based on whether patient has dental insurance.
 * Most dental insurance covers very little for implants ($1,000-$3,000 annual max).
 */
function estimateInsuranceCoverage(
  treatmentValue: number,
  hasDentalInsurance: boolean | null | undefined
): number {
  if (!hasDentalInsurance) return 0
  // Most dental plans cover $1,500-$2,500 annual max
  // Some better plans cover up to $5,000 for major procedures
  return Math.min(2000, treatmentValue * 0.1)
}

/**
 * Convert budget_range enum to an estimated down payment amount.
 */
function budgetRangeToDownPayment(range: BudgetRange | null | undefined): number {
  switch (range) {
    case 'under_10k': return 5000
    case '10k_15k': return 10000
    case '15k_20k': return 15000
    case '20k_25k': return 20000
    case '25k_30k': return 25000
    case 'over_30k': return 30000
    default: return 0
  }
}

/**
 * Calculate affordability: what percentage of estimated monthly income
 * goes to the financing payment.
 */
export function calculateAffordabilityRatio(
  monthlyPayment: number,
  annualIncome?: number
): number {
  if (!annualIncome || annualIncome <= 0) return 0
  const monthlyIncome = annualIncome / 12
  return Math.round((monthlyPayment / monthlyIncome) * 10000) / 100
}
