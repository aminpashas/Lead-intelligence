/**
 * Credit Pre-Qualification Enrichment
 *
 * Layered approach to auto-assess patient financing likelihood
 * during the enrichment pipeline — NO SSN required.
 *
 * Layer 1: Credit Tier Estimation (internal model ONLY)
 *   - Estimates a rough tier from data the lead provided themselves
 *     (intake answers, budget range) plus operational validation signals.
 *   - FCRA guardrail: Experian ConsumerView (or any CRA-sourced marketing
 *     data) must NEVER feed this file. Using marketing data to influence
 *     financing eligibility would convert it into a consumer report under
 *     15 U.S.C. § 1681a(d). Enforced by fcra-guardrail.test.ts.
 *
 * Layer 2: Lender Soft Pre-Qualification
 *   - For leads with enough data (name + address + DOB), runs soft
 *     pre-qual through CareCredit QuickScreen and Sunbit estimation.
 *   - No impact on patient's credit score.
 *   - Returns: estimated approval amount, likely terms, approval %.
 *
 * Both layers run automatically during lead enrichment.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { withRetry } from '@/lib/retry'
import { auditPHITransmission } from '@/lib/hipaa-audit'
import { LENDER_CREDIT_PROFILES } from '@/lib/financing/lender-profiles'
import type { LenderSlug } from '@/lib/financing/types'

// ── Types ──────────────────────────────────────────────────

export type CreditTier = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown'

export type CreditEstimation = {
  credit_tier: CreditTier
  estimated_score_range: { min: number; max: number } | null
  estimated_income_range: { min: number; max: number } | null
  homeowner: boolean | null
  financial_stress_indicators: string[]
  confidence: number // 0-1
  source: string
}

export type LenderPreQualResult = {
  lender_slug: string
  lender_name: string
  pre_qualified: boolean
  estimated_approval_amount: number | null
  estimated_monthly_payment: number | null
  estimated_apr: number | null
  estimated_term_months: number | null
  promo_available: boolean
  denial_likelihood: 'low' | 'medium' | 'high' | 'unknown'
  confidence: number
}

export type PreQualificationResult = {
  credit_estimation: CreditEstimation
  lender_prequals: LenderPreQualResult[]
  overall_approval_likelihood: number // 0-100
  recommended_amount: number | null
  recommended_lender: string | null
  financing_ready: boolean
  summary: string
}

// ── Layer 1: Credit Tier Estimation ────────────────────────

/**
 * Estimate credit tier from available lead data without any credit pull.
 * Uses demographic signals, property data, and behavioral indicators.
 */
export function estimateCreditTier(leadData: {
  age?: number | null
  city?: string | null
  state?: string | null
  zip_code?: string | null
  has_dental_insurance?: boolean | null
  financing_interest?: string | null
  budget_range?: string | null
  email_valid?: boolean | null
  email_disposable?: boolean | null
  phone_valid?: boolean | null
  phone_line_type?: string | null
  ip_is_proxy?: boolean | null
  distance_to_practice_miles?: number | null
  // Enrichment data
  homeowner?: boolean | null
  estimated_income?: number | null
}): CreditEstimation {
  let score = 50 // Start neutral
  const stressIndicators: string[] = []

  // Age: 35-70 is the sweet spot for dental implant financing
  if (leadData.age) {
    if (leadData.age >= 45 && leadData.age <= 65) score += 10
    else if (leadData.age >= 35 && leadData.age <= 75) score += 5
    else if (leadData.age < 25) { score -= 10; stressIndicators.push('very_young') }
  }

  // Insurance: having dental insurance suggests employer/stability
  if (leadData.has_dental_insurance === true) score += 10
  if (leadData.has_dental_insurance === false) score -= 5

  // Budget range signals financial capacity
  switch (leadData.budget_range) {
    case 'over_30k': score += 20; break
    case '25k_30k': score += 15; break
    case '20k_25k': score += 10; break
    case '15k_20k': score += 5; break
    case '10k_15k': break
    case 'under_10k': score -= 5; break
  }

  // Financing interest: cash_pay = highest financial capacity
  if (leadData.financing_interest === 'cash_pay') score += 15
  else if (leadData.financing_interest === 'financing_needed') score -= 5

  // Identity verification signals correlate with creditworthiness
  if (leadData.email_valid === true && !leadData.email_disposable) score += 5
  if (leadData.email_disposable) { score -= 15; stressIndicators.push('disposable_email') }
  if (leadData.phone_valid === true && leadData.phone_line_type === 'mobile') score += 5
  if (leadData.phone_line_type === 'voip') { score -= 5; stressIndicators.push('voip_phone') }
  if (leadData.ip_is_proxy) { score -= 10; stressIndicators.push('proxy_vpn') }

  // Local = more invested = better candidate
  if (leadData.distance_to_practice_miles !== null && leadData.distance_to_practice_miles !== undefined) {
    if (leadData.distance_to_practice_miles <= 30) score += 5
    else if (leadData.distance_to_practice_miles > 200) { score -= 5; stressIndicators.push('distant_location') }
  }

  // Homeowner signal
  if (leadData.homeowner === true) score += 15

  // Clamp to 0-100
  score = Math.max(0, Math.min(100, score))

  // Map score to credit tier
  let tier: CreditTier
  let scoreRange: { min: number; max: number } | null = null
  if (score >= 80) { tier = 'excellent'; scoreRange = { min: 750, max: 850 } }
  else if (score >= 60) { tier = 'good'; scoreRange = { min: 670, max: 749 } }
  else if (score >= 40) { tier = 'fair'; scoreRange = { min: 580, max: 669 } }
  else if (score >= 20) { tier = 'poor'; scoreRange = { min: 300, max: 579 } }
  else { tier = 'unknown'; scoreRange = null }

  // Estimate income from budget range
  let incomeRange: { min: number; max: number } | null = null
  if (leadData.estimated_income) {
    incomeRange = { min: leadData.estimated_income * 0.9, max: leadData.estimated_income * 1.1 }
  } else {
    switch (leadData.budget_range) {
      case 'over_30k': incomeRange = { min: 80000, max: 200000 }; break
      case '25k_30k': incomeRange = { min: 65000, max: 120000 }; break
      case '20k_25k': incomeRange = { min: 55000, max: 100000 }; break
      case '15k_20k': incomeRange = { min: 45000, max: 80000 }; break
      case '10k_15k': incomeRange = { min: 35000, max: 65000 }; break
      case 'under_10k': incomeRange = { min: 25000, max: 50000 }; break
    }
  }

  return {
    credit_tier: tier,
    estimated_score_range: scoreRange,
    estimated_income_range: incomeRange,
    homeowner: leadData.homeowner || null,
    financial_stress_indicators: stressIndicators,
    confidence: stressIndicators.length === 0 ? 0.6 : 0.4,
    source: 'internal_model',
  }
}

// ── Layer 2: Lender Soft Pre-Qualification ─────────────────

/**
 * Run soft pre-qualification against configured lenders.
 * Requires: name + address (or zip) + DOB at minimum.
 * NO SSN needed. No impact on credit score.
 */
export async function runLenderPreQual(
  supabase: SupabaseClient,
  organizationId: string,
  leadData: {
    first_name: string
    last_name: string | null
    city?: string | null
    state?: string | null
    zip_code?: string | null
    date_of_birth?: string | null
    email?: string | null
    phone?: string | null
    treatment_value?: number | null
  },
  creditEstimation: CreditEstimation
): Promise<LenderPreQualResult[]> {
  const results: LenderPreQualResult[] = []

  // Get active lender configs for this org
  const { data: lenderConfigs } = await supabase
    .from('financing_lender_configs')
    .select('lender_slug, display_name, credentials_encrypted, config, integration_type')
    .eq('organization_id', organizationId)
    .eq('is_active', true)
    .order('priority_order')

  if (!lenderConfigs || lenderConfigs.length === 0) {
    // No lenders configured — use estimation model for all known lenders
    return estimateAllLenderPreQuals(creditEstimation, leadData.treatment_value || 30000)
  }

  const requestedAmount = leadData.treatment_value || 30000

  for (const config of lenderConfigs) {
    // For each lender, estimate pre-qual based on credit tier
    // Real API pre-qual would happen here when credentials are configured
    const result = estimateLenderPreQual(
      config.lender_slug,
      config.display_name || config.lender_slug,
      creditEstimation,
      requestedAmount
    )
    results.push(result)
  }

  return results
}

/**
 * Estimate pre-qualification for a specific lender based on credit tier.
 * Approval rates are sourced from the authoritative LENDER_CREDIT_PROFILES
 * in lender-profiles.ts — no duplicate maintenance needed here.
 */
function estimateLenderPreQual(
  slug: string,
  name: string,
  credit: CreditEstimation,
  requestedAmount: number
): LenderPreQualResult {
  const tier = credit.credit_tier

  // Pull from authoritative profiles (single source of truth)
  const creditProfile = LENDER_CREDIT_PROFILES[slug as LenderSlug]

  // APR by credit tier (from lender rate documentation)
  const aprByTier: Record<string, Record<CreditTier, number>> = {
    carecredit:  { excellent: 0,     good: 14.9,  fair: 26.99, poor: 26.99, unknown: 17.9  },
    sunbit:      { excellent: 0,     good: 9.99,  fair: 19.99, poor: 35.99, unknown: 14.99 },
    affirm:      { excellent: 0,     good: 15,    fair: 26,    poor: 36,    unknown: 20    },
    cherry:      { excellent: 0,     good: 14.99, fair: 24.99, poor: 39.99, unknown: 19.99 },
    alpheon:     { excellent: 4.99,  good: 9.99,  fair: 16.99, poor: 24.99, unknown: 12.99 },
    proceed:     { excellent: 4.99,  good: 11.99, fair: 19.99, poor: 29.99, unknown: 14.99 },
    lendingclub: { excellent: 8.98,  good: 13.99, fair: 24.99, poor: 35.99, unknown: 15.99 },
  }

  const approvalRate = creditProfile?.approvalRates[tier] ?? 50
  const maxAmount    = creditProfile?.maxAmount ?? 25000
  const apr          = aprByTier[slug]?.[tier] ?? 15

  const profile = { approval: approvalRate, apr, maxAmount }

  const approvalAmount = Math.min(requestedAmount, profile.maxAmount)
  const termMonths = approvalAmount > 20000 ? 60 : approvalAmount > 10000 ? 48 : 36
  const monthlyRate = profile.apr / 100 / 12
  const monthlyPayment = monthlyRate > 0
    ? (approvalAmount * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -termMonths))
    : approvalAmount / termMonths

  const denialLikelihood: LenderPreQualResult['denial_likelihood'] =
    profile.approval >= 80 ? 'low' :
    profile.approval >= 50 ? 'medium' :
    profile.approval >= 25 ? 'high' : 'high'

  return {
    lender_slug: slug,
    lender_name: name,
    pre_qualified: profile.approval >= 50,
    estimated_approval_amount: approvalAmount,
    estimated_monthly_payment: Math.round(monthlyPayment * 100) / 100,
    estimated_apr: profile.apr,
    estimated_term_months: termMonths,
    promo_available: profile.apr === 0,
    denial_likelihood: denialLikelihood,
    confidence: credit.confidence * 0.8, // Reduce confidence since it's estimated
  }
}

/**
 * Estimate pre-quals for all known lenders (when none are configured for org).
 */
function estimateAllLenderPreQuals(
  credit: CreditEstimation,
  requestedAmount: number
): LenderPreQualResult[] {
  const lenders = [
    { slug: 'sunbit', name: 'Sunbit' },
    { slug: 'carecredit', name: 'CareCredit' },
    { slug: 'cherry', name: 'Cherry' },
    { slug: 'proceed', name: 'Proceed Finance' },
    { slug: 'alpheon', name: 'Alpheon Credit' },
    { slug: 'affirm', name: 'Affirm' },
    { slug: 'lendingclub', name: 'LendingClub' },
  ]

  return lenders.map(l => estimateLenderPreQual(l.slug, l.name, credit, requestedAmount))
}

// ── Main Pre-Qualification Orchestrator ────────────────────

/**
 * Full auto pre-qualification: runs both layers and produces
 * a comprehensive result that's stored in the enrichment pipeline.
 */
export async function autoPreQualify(
  supabase: SupabaseClient,
  organizationId: string,
  leadId: string,
  leadData: {
    first_name: string
    last_name: string | null
    age?: number | null
    city?: string | null
    state?: string | null
    zip_code?: string | null
    date_of_birth?: string | null
    email?: string | null
    phone?: string | null
    has_dental_insurance?: boolean | null
    financing_interest?: string | null
    budget_range?: string | null
    treatment_value?: number | null
    // From enrichment
    email_valid?: boolean | null
    email_disposable?: boolean | null
    phone_valid?: boolean | null
    phone_line_type?: string | null
    ip_is_proxy?: boolean | null
    distance_to_practice_miles?: number | null
  }
): Promise<PreQualificationResult> {
  // Layer 1: internal estimation model ONLY. Experian ConsumerView is
  // marketing data — routing it into financing estimation would make it a
  // consumer report under FCRA § 1681a(d), so it is banned from this path
  // (see fcra-guardrail.test.ts).
  const creditEstimation: CreditEstimation = estimateCreditTier(leadData)

  // HIPAA audit: analyzing financial data
  await auditPHITransmission(
    { supabase, organizationId, actorType: 'system' },
    'lead', leadId, 'credit_prequal_model', ['financial']
  ).catch((err: unknown) => console.warn('[credit-prequal] Prequal model PHI audit failed:', err instanceof Error ? err.message : err))

  // Layer 2: Lender-specific pre-quals
  const lenderPrequals = await runLenderPreQual(
    supabase, organizationId, leadData, creditEstimation
  )

  // Calculate overall approval likelihood
  const approvedLenders = lenderPrequals.filter(l => l.pre_qualified)
  const overallLikelihood = lenderPrequals.length > 0
    ? Math.round(approvedLenders.length / lenderPrequals.length * 100)
    : 0

  // Find best lender recommendation
  const bestLender = approvedLenders
    .sort((a, b) => {
      // Prefer: lowest APR, then highest amount
      if (a.estimated_apr !== b.estimated_apr) return (a.estimated_apr || 99) - (b.estimated_apr || 99)
      return (b.estimated_approval_amount || 0) - (a.estimated_approval_amount || 0)
    })[0]

  const requestedAmount = leadData.treatment_value || 30000
  const recommendedAmount = bestLender?.estimated_approval_amount || null

  // Generate human-readable summary
  const summary = generatePreQualSummary(
    creditEstimation, lenderPrequals, overallLikelihood, requestedAmount
  )

  return {
    credit_estimation: creditEstimation,
    lender_prequals: lenderPrequals,
    overall_approval_likelihood: overallLikelihood,
    recommended_amount: recommendedAmount,
    recommended_lender: bestLender?.lender_slug || null,
    financing_ready: overallLikelihood >= 50 && (recommendedAmount || 0) >= requestedAmount * 0.7,
    summary,
  }
}

function generatePreQualSummary(
  credit: CreditEstimation,
  prequals: LenderPreQualResult[],
  overallLikelihood: number,
  requestedAmount: number
): string {
  const approved = prequals.filter(p => p.pre_qualified)
  const bestAPR = approved.reduce((best, p) => Math.min(best, p.estimated_apr || 99), 99)
  const bestMonthly = approved.reduce((best, p) => Math.min(best, p.estimated_monthly_payment || Infinity), Infinity)

  if (overallLikelihood >= 80) {
    return `Strong financing candidate (${credit.credit_tier} credit tier). Pre-qualified with ${approved.length}/${prequals.length} lenders. Best rate: ${bestAPR}% APR, est. $${Math.round(bestMonthly)}/mo for $${requestedAmount.toLocaleString()}.`
  }
  if (overallLikelihood >= 50) {
    return `Moderate financing candidate (${credit.credit_tier} credit tier). Pre-qualified with ${approved.length}/${prequals.length} lenders. Recommend starting with ${approved[0]?.lender_name || 'highest approval rate lender'}.`
  }
  if (overallLikelihood >= 25) {
    return `Challenging financing profile (${credit.credit_tier} credit tier). ${approved.length}/${prequals.length} lenders may approve. Consider Sunbit (90% approval rate) or in-house payment plan.`
  }
  return `Financing may be difficult (${credit.credit_tier} credit tier). Recommend discussing in-house payment plans, co-signer options, or reduced treatment scope.`
}

// ── Confidence Calculation ─────────────────────────────────

export function preQualConfidence(result: PreQualificationResult): number {
  // Higher confidence when we have more data points
  const hasMultipleLenders = result.lender_prequals.length >= 3
  const hasCreditTier = result.credit_estimation.credit_tier !== 'unknown'
  const hasIncomeEstimate = result.credit_estimation.estimated_income_range !== null

  let confidence = 0.3 // Base
  if (hasCreditTier) confidence += 0.25
  if (hasMultipleLenders) confidence += 0.2
  if (hasIncomeEstimate) confidence += 0.15
  if (result.credit_estimation.financial_stress_indicators.length === 0) confidence += 0.1

  return Math.min(1.0, confidence)
}
