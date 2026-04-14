/**
 * AI Financial Coach
 *
 * Helps patients build a realistic payment plan by combining multiple
 * funding sources: insurance, HSA/FSA, savings, financing, in-house plans.
 *
 * Also handles denial scenarios with creative alternatives and
 * provides the AI agent with financial coaching talking points.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Lead, FinancialSignals, FinancingContext } from '@/types/database'
import { buildFinancingBreakdown, type FinancingBreakdown } from '@/lib/financing/calculator'
import type { LenderSlug } from '@/lib/financing/types'
import { logger } from '@/lib/logger'

// ── Budget Breakdown Types ─────────────────────────────────────

export type FundingSource = {
  source: string
  label: string
  amount: number
  is_confirmed: boolean
  notes: string
}

export type BudgetPlan = {
  treatment_value: number
  funding_sources: FundingSource[]
  total_covered: number
  remaining_gap: number
  financing_needed: number
  estimated_monthly: number
  estimated_term_months: number
  affordability_ratio: number | null  // % of estimated monthly income
  savings_tips: string[]
  coaching_notes: string
}

export type DenialStrategy = {
  strategy: string
  description: string
  estimated_savings: number
  action_required: string
  priority: number
}

// ── Build Financing Context ────────────────────────────────────

/**
 * Build the complete FinancingContext for a lead — injected into AI agent context.
 * Gives the AI full awareness of the lead's financial situation.
 */
export async function buildFinancingContext(
  supabase: SupabaseClient,
  leadId: string,
  organizationId: string
): Promise<FinancingContext> {
  // Load lead financial data
  const { data: lead } = await supabase
    .from('leads')
    .select(`
      financing_approved, financing_amount, financing_application_id,
      financial_signals, financial_qualification_tier, financing_readiness_score,
      treatment_value, has_dental_insurance, insurance_details,
      has_hsa_fsa, estimated_down_payment, preferred_monthly_budget, budget_range
    `)
    .eq('id', leadId)
    .single()

  if (!lead) {
    return {
      status: 'none',
      readiness_score: 0,
      qualification_tier: 'tier_c',
    }
  }

  // Check for financing applications
  const { data: applications } = await supabase
    .from('financing_applications')
    .select('status, approved_lender_slug, approved_amount, approved_terms')
    .eq('lead_id', leadId)
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(3)

  // Get denied lender names
  const { data: deniedSubmissions } = await supabase
    .from('financing_submissions')
    .select('lender_slug')
    .eq('lead_id', leadId)
    .eq('status', 'denied')

  const deniedLenders = deniedSubmissions?.map(s => s.lender_slug) || []

  // Determine status
  let status: FinancingContext['status'] = 'none'
  let approvedAmount: number | undefined
  let monthlyPayment: number | undefined
  let apr: number | undefined
  let termMonths: number | undefined
  let lender: string | undefined

  const latestApp = applications?.[0]
  if (latestApp) {
    if (latestApp.status === 'approved') {
      status = 'approved'
      approvedAmount = latestApp.approved_amount
      lender = latestApp.approved_lender_slug
      if (latestApp.approved_terms) {
        monthlyPayment = latestApp.approved_terms.monthly_payment
        apr = latestApp.approved_terms.apr
        termMonths = latestApp.approved_terms.term_months
      }
    } else if (latestApp.status === 'denied') {
      status = deniedLenders.length < 4 ? 'partial' : 'denied'
    } else if (latestApp.status === 'pending' || latestApp.status === 'in_progress') {
      status = 'pending'
    }
  }

  // Build budget breakdown if we have treatment value
  let budgetBreakdown: FinancingContext['budget_breakdown']
  if (lead.treatment_value) {
    const signals = (lead.financial_signals || {}) as Partial<FinancialSignals>
    const insuranceCoverage = lead.has_dental_insurance ? 2000 : 0
    const hsaFsa = lead.has_hsa_fsa ? 1500 : 0  // Conservative estimate
    const downPayment = lead.estimated_down_payment || signals.down_payment_mentioned || 0
    const amountToFinance = Math.max(0, lead.treatment_value - insuranceCoverage - hsaFsa - downPayment)

    // Rough monthly estimate at 60 months
    const estMonthly = amountToFinance > 0
      ? Math.round((amountToFinance * (0.149 / 12)) / (1 - Math.pow(1 + 0.149 / 12, -60)))
      : 0

    budgetBreakdown = {
      treatment_value: lead.treatment_value,
      insurance_coverage: insuranceCoverage,
      hsa_fsa: hsaFsa,
      down_payment: downPayment,
      amount_to_finance: amountToFinance,
      estimated_monthly: monthlyPayment || estMonthly,
    }
  }

  return {
    status,
    approved_amount: approvedAmount,
    monthly_payment: monthlyPayment,
    apr,
    term_months: termMonths,
    lender,
    denied_lenders: deniedLenders.length > 0 ? deniedLenders : undefined,
    readiness_score: lead.financing_readiness_score || 0,
    qualification_tier: lead.financial_qualification_tier || 'tier_c',
    budget_breakdown: budgetBreakdown,
  }
}

// ── Budget Plan Builder ────────────────────────────────────────

/**
 * Build a comprehensive multi-source budget plan for a patient.
 * Used by the AI to present creative payment solutions.
 */
export function buildBudgetPlan(
  treatmentValue: number,
  lead: Partial<Lead>,
  financingBreakdown?: FinancingBreakdown
): BudgetPlan {
  const signals = (lead.financial_signals || {}) as Partial<FinancialSignals>
  const sources: FundingSource[] = []
  const tips: string[] = []

  // 1. Dental Insurance
  const hasInsurance = lead.has_dental_insurance || signals.has_insurance
  const insuranceEstimate = hasInsurance ? Math.min(2000, treatmentValue * 0.1) : 0
  if (insuranceEstimate > 0) {
    sources.push({
      source: 'dental_insurance',
      label: 'Dental Insurance',
      amount: insuranceEstimate,
      is_confirmed: false,
      notes: signals.insurance_provider
        ? `${signals.insurance_provider} — estimated annual max benefit. Varies by plan.`
        : 'Estimated based on typical dental plan annual max ($1,500–$2,500).',
    })
  } else {
    tips.push('Check if you have dental insurance through work — even basic plans cover $1,000–$2,500 toward implants.')
  }

  // 2. HSA/FSA
  const hasHsa = lead.has_hsa_fsa || signals.has_hsa_fsa
  const hsaEstimate = hasHsa ? 1500 : 0
  if (hsaEstimate > 0) {
    sources.push({
      source: 'hsa_fsa',
      label: 'HSA/FSA (Pre-Tax Savings)',
      amount: hsaEstimate,
      is_confirmed: false,
      notes: 'Dental implants are HSA/FSA eligible. Using pre-tax dollars saves you 20-30% effectively.',
    })
  } else {
    tips.push('Do you have an HSA or FSA through work? Dental implants qualify — you\'d save 20-30% in tax savings.')
  }

  // 3. Personal savings / down payment
  const downPayment = lead.estimated_down_payment || signals.down_payment_mentioned || 0
  if (downPayment > 0) {
    sources.push({
      source: 'savings',
      label: 'Down Payment / Savings',
      amount: downPayment,
      is_confirmed: false,
      notes: 'Putting money down reduces your financed amount and monthly payments.',
    })
  }

  // 4. Tax refund
  const isQ1 = new Date().getMonth() < 4
  if (isQ1 && treatmentValue > 15000) {
    const taxRefundEstimate = 3000
    sources.push({
      source: 'tax_refund',
      label: 'Tax Refund (Seasonal)',
      amount: taxRefundEstimate,
      is_confirmed: false,
      notes: 'Average U.S. tax refund is ~$3,000. Can apply as a lump-sum to reduce your balance.',
    })
    tips.push('If you\'re expecting a tax refund, applying it as a lump sum could save you hundreds in interest.')
  }

  // Calculate remaining to finance
  const totalCovered = sources.reduce((sum, s) => sum + s.amount, 0)
  const financingNeeded = Math.max(0, treatmentValue - totalCovered)

  // 5. Financing (the main funding source)
  let estMonthly = 0
  let estTermMonths = 60

  if (financingBreakdown && financingBreakdown.recommendation.best_overall) {
    const best = financingBreakdown.recommendation.best_overall
    estMonthly = best.monthly_payment
    estTermMonths = best.term_months
  } else if (financingNeeded > 0) {
    // Default estimate at 14.9% APR, 60 months
    const r = 0.149 / 12
    estMonthly = Math.round((financingNeeded * r) / (1 - Math.pow(1 + r, -60)))
  }

  if (financingNeeded > 0) {
    sources.push({
      source: 'financing',
      label: 'Patient Financing',
      amount: financingNeeded,
      is_confirmed: false,
      notes: `Estimated $${estMonthly}/mo over ${estTermMonths} months. Multiple lender options available.`,
    })
  }

  // Savings tips
  if (financingNeeded > 10000) {
    tips.push('Switching to bi-weekly payments (every 2 weeks instead of monthly) can save you $500–$1,500 in interest.')
  }
  if (financingNeeded > 0 && !hasHsa) {
    tips.push('Ask your employer about enrolling in an FSA — you can set aside pre-tax money for next year\'s dental expenses.')
  }
  if (lead.financing_interest !== 'cash_pay' && downPayment === 0) {
    tips.push('Even a small down payment ($1,000–$3,000) significantly reduces your monthly payments.')
  }

  // Coaching notes — summary for the AI agent
  const coaching = generateCoachingNotes(treatmentValue, sources, financingNeeded, estMonthly, lead, signals)

  // Monthly budget affordability
  const monthlyBudget = signals.budget_monthly || lead.preferred_monthly_budget
  let affordabilityRatio: number | null = null
  if (monthlyBudget && estMonthly > 0) {
    affordabilityRatio = Math.round((estMonthly / monthlyBudget) * 100)
  }

  return {
    treatment_value: treatmentValue,
    funding_sources: sources,
    total_covered: totalCovered,
    remaining_gap: Math.max(0, treatmentValue - totalCovered - financingNeeded),
    financing_needed: financingNeeded,
    estimated_monthly: estMonthly,
    estimated_term_months: estTermMonths,
    affordability_ratio: affordabilityRatio,
    savings_tips: tips,
    coaching_notes: coaching,
  }
}

// ── Denial Strategy Generator ──────────────────────────────────

/**
 * When a lead is denied financing, generate creative alternative strategies.
 * The AI uses these to coach the patient through alternative paths.
 */
export function generateDenialStrategies(
  treatmentValue: number,
  lead: Partial<Lead>,
  deniedLenders: string[]
): DenialStrategy[] {
  const strategies: DenialStrategy[] = []
  const signals = (lead.financial_signals || {}) as Partial<FinancialSignals>

  // Strategy 1: In-house payment plan
  strategies.push({
    strategy: 'in_house_plan',
    description: 'Work directly with the practice on a custom payment plan — no credit check needed.',
    estimated_savings: 0,
    action_required: 'Ask the patient coordinator about in-house financing options.',
    priority: 1,
  })

  // Strategy 2: Alternative lenders not yet tried
  const allLenders: LenderSlug[] = ['carecredit', 'sunbit', 'proceed', 'lendingclub', 'cherry', 'alpheon', 'affirm']
  const untried = allLenders.filter(l => !deniedLenders.includes(l))
  if (untried.length > 0) {
    strategies.push({
      strategy: 'alternative_lenders',
      description: `Try alternative lenders with higher approval rates: ${untried.slice(0, 3).join(', ')}. Each lender has different criteria.`,
      estimated_savings: 0,
      action_required: 'Submit applications to remaining lenders.',
      priority: 2,
    })
  }

  // Strategy 3: Phased treatment
  if (treatmentValue > 20000) {
    strategies.push({
      strategy: 'phased_treatment',
      description: 'Start with one arch (upper OR lower) now, and do the second arch in 6-12 months. This cuts the immediate cost roughly in half.',
      estimated_savings: Math.round(treatmentValue * 0.45),
      action_required: 'Discuss phased treatment with the doctor at consultation.',
      priority: 3,
    })
  }

  // Strategy 4: Increased down payment
  if (!signals.has_savings && !signals.down_payment_mentioned) {
    strategies.push({
      strategy: 'increase_down_payment',
      description: 'A larger down payment reduces the financed amount, which may help with approval. Even $2,000–$5,000 can make a difference.',
      estimated_savings: Math.round(treatmentValue * 0.03),
      action_required: 'Explore savings options: tax refund, HSA/FSA, family assistance.',
      priority: 4,
    })
  }

  // Strategy 5: Co-signer
  strategies.push({
    strategy: 'co_signer',
    description: 'Having a family member co-sign can significantly improve approval chances. The co-signer\'s credit is used for qualification.',
    estimated_savings: 0,
    action_required: 'Discuss co-signer option with a trusted family member.',
    priority: 5,
  })

  // Strategy 6: Credit improvement + re-apply
  if (signals.barriers?.includes('credit_concern')) {
    strategies.push({
      strategy: 'credit_improvement',
      description: 'Small credit improvements (paying down a credit card, disputing errors) can improve your score in 30-90 days. Then re-apply.',
      estimated_savings: 0,
      action_required: 'Check credit report for errors. Pay down highest-utilization cards. Re-apply in 60-90 days.',
      priority: 6,
    })
  }

  return strategies.sort((a, b) => a.priority - b.priority)
}

// ── Format for AI Agent Prompt ─────────────────────────────────

/**
 * Format the full financial coaching context for inclusion in AI agent prompts.
 * This gives the AI everything it needs to have an informed financial conversation.
 */
export function formatFinancingContextForPrompt(ctx: FinancingContext): string {
  const lines: string[] = ['', '── FINANCIAL CONTEXT ──']

  // Status overview
  lines.push(`Financing Status: ${ctx.status.toUpperCase()}`)
  lines.push(`Financial Readiness: ${ctx.readiness_score}/100 (Tier ${ctx.qualification_tier.replace('tier_', '').toUpperCase()})`)

  if (ctx.status === 'approved') {
    lines.push(`✅ Approved: $${ctx.approved_amount?.toLocaleString()} via ${ctx.lender}`)
    if (ctx.monthly_payment) lines.push(`   Monthly Payment: $${ctx.monthly_payment}/mo`)
    if (ctx.apr) lines.push(`   APR: ${ctx.apr}% for ${ctx.term_months} months`)
  }

  if (ctx.status === 'denied' || ctx.status === 'partial') {
    if (ctx.denied_lenders?.length) {
      lines.push(`❌ Denied by: ${ctx.denied_lenders.join(', ')}`)
    }
    lines.push('💡 Alternative options available: in-house plans, phased treatment, alternative lenders')
  }

  if (ctx.budget_breakdown) {
    const bb = ctx.budget_breakdown
    lines.push('')
    lines.push('── BUDGET BREAKDOWN ──')
    lines.push(`Treatment Value:      $${bb.treatment_value.toLocaleString()}`)
    if (bb.insurance_coverage > 0) lines.push(`Insurance Coverage:  -$${bb.insurance_coverage.toLocaleString()}`)
    if (bb.hsa_fsa > 0) lines.push(`HSA/FSA:             -$${bb.hsa_fsa.toLocaleString()}`)
    if (bb.down_payment > 0) lines.push(`Down Payment:        -$${bb.down_payment.toLocaleString()}`)
    lines.push(`Amount to Finance:    $${bb.amount_to_finance.toLocaleString()}`)
    lines.push(`Estimated Monthly:    $${bb.estimated_monthly}/mo`)
  }

  lines.push('')
  lines.push('── COACHING GUIDELINES ──')

  switch (ctx.qualification_tier) {
    case 'tier_a':
      lines.push('This patient is READY for financing. Present specific numbers confidently.')
      lines.push('Offer to walk them through the 2-minute application.')
      break
    case 'tier_b':
      lines.push('This patient is WARM. Educate on affordability without pushing.')
      lines.push('Use "as low as $X/mo" framing. Answer cost questions with real ranges.')
      break
    case 'tier_c':
      lines.push('This patient has NOT shown financial signals yet. Focus on value, not cost.')
      lines.push('Do NOT mention financing unless they ask. Build desire first.')
      break
    case 'tier_d':
      lines.push('This patient has expressed financial barriers. Be empathetic.')
      lines.push('Explore in-house plans, phased treatment, or creative alternatives.')
      lines.push('NEVER make them feel bad about their financial situation.')
      break
  }

  return lines.join('\n')
}

// ── Internal Helpers ───────────────────────────────────────────

function generateCoachingNotes(
  treatmentValue: number,
  sources: FundingSource[],
  financingNeeded: number,
  estMonthly: number,
  lead: Partial<Lead>,
  signals: Partial<FinancialSignals>
): string {
  const parts: string[] = []

  parts.push(`Treatment value: $${treatmentValue.toLocaleString()}.`)

  if (sources.length > 1) {
    const nonFinancing = sources.filter(s => s.source !== 'financing')
    const totalNonFinancing = nonFinancing.reduce((sum, s) => sum + s.amount, 0)
    parts.push(`By combining ${nonFinancing.map(s => s.label).join(' + ')}, we can reduce the financed amount by $${totalNonFinancing.toLocaleString()}.`)
  }

  if (estMonthly > 0) {
    parts.push(`Estimated monthly: $${estMonthly}/mo.`)
  }

  const budget = signals.budget_monthly || lead.preferred_monthly_budget
  if (budget) {
    if (estMonthly <= budget) {
      parts.push(`✅ This fits within their stated budget of $${budget}/mo.`)
    } else {
      const gap = estMonthly - budget
      parts.push(`⚠️ $${gap}/mo above their stated budget of $${budget}/mo. Discuss longer terms, larger down payment, or phased treatment.`)
    }
  }

  if (signals.barriers && signals.barriers.length > 0) {
    parts.push(`Barriers to address: ${signals.barriers.join(', ')}.`)
  }

  return parts.join(' ')
}
