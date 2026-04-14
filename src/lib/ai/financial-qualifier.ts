/**
 * Financial Qualifier — AI-Driven Soft Pre-Qualification Engine
 *
 * Extracts financial readiness signals from natural conversation text
 * WITHOUT asking direct income/credit questions. The AI infers financial
 * capacity from organic dialogue patterns.
 *
 * Output: FinancialSignals + qualification tier (A/B/C/D)
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { FinancialSignals, FinancialQualificationTier, Lead } from '@/types/database'
import { logger } from '@/lib/logger'

// ── Signal Extraction Patterns ─────────────────────────────────

const INSURANCE_PATTERNS = [
  /\b(i have|got|my)\s+(dental\s+)?insurance\b/i,
  /\b(delta\s*dental|cigna|aetna|metlife|united\s*health|humana|guardian|bcbs|blue\s*cross)\b/i,
  /\binsurance\s+(covers?|pays?|will\s+cover)\b/i,
  /\bmy\s+plan\s+(covers?|includes?)\b/i,
]

const NO_INSURANCE_PATTERNS = [
  /\b(don'?t|do\s*not|no)\s+have\s+(dental\s+)?insurance\b/i,
  /\bno\s+insurance\b/i,
  /\buninsured\b/i,
  /\bwithout\s+insurance\b/i,
]

const FINANCING_INTEREST_HIGH = [
  /\b(interested\s+in|need|want|looking\s+for)\s+(financing|payment\s+plan|monthly\s+payments?)\b/i,
  /\bhow\s+(much|can\s+i)\s+(per|a|each)\s+month\b/i,
  /\bwhat\s+are\s+the\s+(monthly\s+)?payments?\b/i,
  /\bcan\s+i\s+(finance|make\s+payments|pay\s+monthly)\b/i,
  /\bdo\s+you\s+(offer|have)\s+(financing|payment\s+plans?)\b/i,
  /\bapproved?\s+for\s+financing\b/i,
  /\bapply\s+for\s+(credit|financing|loan)\b/i,
]

const FINANCING_INTEREST_MEDIUM = [
  /\bwhat\s+(does|would)\s+(it|this|that|the\s+procedure)\s+cost\b/i,
  /\bhow\s+much\s+(does|is|would|will)\b/i,
  /\bwhat'?s\s+the\s+(price|cost|total)\b/i,
  /\bprice\s+(range|estimate|quote)\b/i,
  /\baffordable?\b/i,
  /\bbudget\b/i,
]

const SAVINGS_PATTERNS = [
  /\b(been\s+)?saving\s+(up|for)\b/i,
  /\b(have|got)\s+(some\s+)?savings\b/i,
  /\bput\s+(down|aside)\b/i,
  /\bdown\s+payment\b/i,
  /\bpay\s+cash\b/i,
  /\bpay\s+(in\s+)?full\b/i,
]

const HSA_FSA_PATTERNS = [
  /\b(hsa|fsa|health\s+savings|flex\s+spend|flexible\s+spending)\b/i,
  /\bpre-?tax\s+(savings|account|money)\b/i,
]

const BUDGET_PATTERNS = [
  /\$\s*(\d{2,4})\s*(?:\/|\s*per\s*|\s*a\s+)(?:mo|month)\b/i,
  /\b(\d{2,4})\s+(?:per|a|each)\s+month\b/i,
  /\bmonthly\s+(?:budget|payment)\s+(?:of|around|about|is)\s+\$?\s*(\d{2,4})\b/i,
  /\bafford\s+(?:about|around|maybe)?\s*\$?\s*(\d{2,4})\s*(?:\/|\s*per\s*|\s*a\s+)mo/i,
  /\bcan\s+do\s+(?:about|around|maybe)?\s*\$?\s*(\d{2,4})\b/i,
]

const DOWN_PAYMENT_PATTERNS = [
  /\bput\s+(?:down|aside)\s+(?:about|around|maybe)?\s*\$?\s*(\d{3,6})\b/i,
  /\bdown\s+payment\s+(?:of)?\s*\$?\s*(\d{3,6})\b/i,
  /\bhave\s+\$?\s*(\d{3,6})\s+(?:saved|ready|available|to\s+put\s+down)\b/i,
  /\bstart\s+with\s+\$?\s*(\d{3,6})\b/i,
]

const BARRIER_PATTERNS: Array<{ pattern: RegExp; barrier: string }> = [
  { pattern: /\bcan'?t\s+afford\b/i, barrier: 'affordability_concern' },
  { pattern: /\btoo\s+expensive\b/i, barrier: 'price_objection' },
  { pattern: /\bno\s+money\b/i, barrier: 'no_funds' },
  { pattern: /\b(bad|poor|low)\s+credit\b/i, barrier: 'credit_concern' },
  { pattern: /\bnot\s+(?:a\s+)?good\s+(?:time|right\s+now)\b/i, barrier: 'timing_barrier' },
  { pattern: /\bneed\s+to\s+(?:talk|ask|check)\s+(?:with|to)\s+(?:my\s+)?(spouse|wife|husband|partner|family)\b/i, barrier: 'decision_maker_absent' },
  { pattern: /\bdivorce|child\s+support|alimony\b/i, barrier: 'financial_obligations' },
  { pattern: /\bjust\s+lost\s+(?:my\s+)?job\b/i, barrier: 'employment_instability' },
  { pattern: /\b(on\s+)?disability|(?:fixed|limited)\s+income|social\s+security|ssi|ssdi\b/i, barrier: 'fixed_income' },
  { pattern: /\bretired?\s+(?:on\s+)?(?:fixed|limited)\b/i, barrier: 'retirement_fixed_income' },
]

// ── Core Signal Extraction ─────────────────────────────────────

/**
 * Extract financial signals from a block of conversation text.
 * Designed to work on conversation transcripts, SMS messages, or email body.
 */
export function extractFinancialSignals(text: string): Partial<FinancialSignals> {
  const signals: Partial<FinancialSignals> = {
    price_aware: false,
    financing_curious: false,
    budget_conscious: false,
    barriers: [],
  }

  // Insurance detection
  const hasInsurance = INSURANCE_PATTERNS.some(p => p.test(text))
  const noInsurance = NO_INSURANCE_PATTERNS.some(p => p.test(text))
  if (hasInsurance) signals.has_insurance = true
  if (noInsurance) signals.has_insurance = false

  // Extract insurance provider
  const providerMatch = text.match(/\b(delta\s*dental|cigna|aetna|metlife|united\s*health|humana|guardian|bcbs|blue\s*cross)\b/i)
  if (providerMatch) signals.insurance_provider = providerMatch[1]

  // Financing interest level
  const highFinancing = FINANCING_INTEREST_HIGH.some(p => p.test(text))
  const medFinancing = FINANCING_INTEREST_MEDIUM.some(p => p.test(text))
  if (highFinancing) {
    signals.financing_interest = 'high'
    signals.financing_curious = true
    signals.price_aware = true
  } else if (medFinancing) {
    signals.financing_interest = 'medium'
    signals.price_aware = true
  }

  // Savings detection
  if (SAVINGS_PATTERNS.some(p => p.test(text))) {
    signals.has_savings = true
  }

  // HSA/FSA detection
  if (HSA_FSA_PATTERNS.some(p => p.test(text))) {
    signals.has_hsa_fsa = true
  }

  // Monthly budget extraction
  for (const pattern of BUDGET_PATTERNS) {
    const match = text.match(pattern)
    if (match) {
      const amount = parseInt(match[1] || match[2], 10)
      if (amount >= 50 && amount <= 5000) {
        signals.budget_monthly = amount
        signals.budget_conscious = true
        break
      }
    }
  }

  // Down payment extraction
  for (const pattern of DOWN_PAYMENT_PATTERNS) {
    const match = text.match(pattern)
    if (match) {
      const amount = parseInt(match[1], 10)
      if (amount >= 100 && amount <= 100000) {
        signals.down_payment_mentioned = amount
        break
      }
    }
  }

  // Barrier detection
  const barriers: string[] = []
  for (const { pattern, barrier } of BARRIER_PATTERNS) {
    if (pattern.test(text)) {
      barriers.push(barrier)
    }
  }
  signals.barriers = barriers

  return signals
}

/**
 * Merge new signals into existing signals (additive — never removes positive signals).
 * Once a lead says "I have insurance", that stays true even if future messages don't mention it.
 */
export function mergeFinancialSignals(
  existing: Partial<FinancialSignals> | null,
  incoming: Partial<FinancialSignals>
): FinancialSignals {
  const merged: FinancialSignals = {
    has_insurance: incoming.has_insurance ?? existing?.has_insurance ?? null,
    insurance_provider: incoming.insurance_provider ?? existing?.insurance_provider ?? null,
    financing_interest: upgradeFinancingInterest(existing?.financing_interest, incoming.financing_interest),
    budget_monthly: incoming.budget_monthly ?? existing?.budget_monthly ?? null,
    down_payment_mentioned: incoming.down_payment_mentioned ?? existing?.down_payment_mentioned ?? null,
    has_savings: incoming.has_savings || existing?.has_savings || null,
    has_hsa_fsa: incoming.has_hsa_fsa || existing?.has_hsa_fsa || null,
    price_aware: incoming.price_aware || existing?.price_aware || false,
    financing_curious: incoming.financing_curious || existing?.financing_curious || false,
    budget_conscious: incoming.budget_conscious || existing?.budget_conscious || false,
    barriers: [...new Set([...(existing?.barriers || []), ...(incoming.barriers || [])])],
    readiness_score: 0, // recalculated below
    last_updated: new Date().toISOString(),
  }

  // Calculate readiness score based on all signals
  merged.readiness_score = calculateReadinessScore(merged)

  return merged
}

/**
 * Determine qualification tier based on financial signals.
 */
export function determineQualificationTier(
  signals: FinancialSignals,
  lead: Partial<Lead>
): FinancialQualificationTier {
  const score = signals.readiness_score

  // Tier D: Active barriers that indicate inability to proceed
  const criticalBarriers = ['no_funds', 'employment_instability']
  const hasCriticalBarrier = signals.barriers.some(b => criticalBarriers.includes(b))
  if (hasCriticalBarrier && !signals.has_savings && !signals.has_insurance) {
    return 'tier_d'
  }

  // Tier A: Ready to receive financing link
  if (score >= 65) return 'tier_a'

  // Tier B: Warm — needs more education before financing
  if (score >= 35) return 'tier_b'

  // Tier C: Cold — no financial signals yet
  return 'tier_c'
}

/**
 * Process a conversation message and update lead financial profile.
 * Called after every inbound message to incrementally build financial picture.
 */
export async function processFinancialSignals(
  supabase: SupabaseClient,
  leadId: string,
  organizationId: string,
  messageText: string,
  existingLeadData?: Partial<Lead>
): Promise<{ signals: FinancialSignals; tier: FinancialQualificationTier }> {
  // Extract signals from new message
  const newSignals = extractFinancialSignals(messageText)

  // Load existing lead data if not provided
  let lead = existingLeadData
  if (!lead) {
    const { data } = await supabase
      .from('leads')
      .select('financial_signals, financing_approved, financing_amount, engagement_score, total_messages_received, status, consultation_date, has_dental_insurance')
      .eq('id', leadId)
      .single()
    lead = data ?? {}
  }

  // Merge with existing signals
  const existingSignals = (lead.financial_signals || {}) as Partial<FinancialSignals>
  const mergedSignals = mergeFinancialSignals(existingSignals, newSignals)

  // Determine qualification tier
  const tier = determineQualificationTier(mergedSignals, lead)

  // Persist to database
  const updates: Record<string, unknown> = {
    financial_signals: mergedSignals,
    financial_qualification_tier: tier,
    financing_readiness_score: mergedSignals.readiness_score,
  }

  // Update specific columns from signals
  if (mergedSignals.budget_monthly) updates.preferred_monthly_budget = mergedSignals.budget_monthly
  if (mergedSignals.has_hsa_fsa !== null) updates.has_hsa_fsa = mergedSignals.has_hsa_fsa
  if (mergedSignals.down_payment_mentioned) updates.estimated_down_payment = mergedSignals.down_payment_mentioned

  await supabase.from('leads').update(updates).eq('id', leadId)

  logger.info('Financial signals updated', {
    leadId,
    tier,
    readinessScore: mergedSignals.readiness_score,
    signalCount: Object.values(mergedSignals).filter(v => v !== null && v !== false && v !== 0).length,
  })

  return { signals: mergedSignals, tier }
}

// ── Internal Helpers ───────────────────────────────────────────

function calculateReadinessScore(signals: FinancialSignals): number {
  let score = 0

  // Positive signals (additive)
  if (signals.price_aware) score += 15
  if (signals.financing_curious) score += 20
  if (signals.financing_interest === 'high') score += 25
  else if (signals.financing_interest === 'medium') score += 10
  if (signals.budget_monthly) score += 15
  if (signals.has_savings) score += 10
  if (signals.has_insurance) score += 10
  if (signals.has_hsa_fsa) score += 5
  if (signals.down_payment_mentioned) score += 10

  // Negative signals (subtract)
  if (signals.barriers.includes('no_funds')) score -= 20
  if (signals.barriers.includes('credit_concern')) score -= 10
  if (signals.barriers.includes('employment_instability')) score -= 15
  if (signals.barriers.includes('affordability_concern')) score -= 10
  if (signals.barriers.includes('price_objection')) score -= 5

  return Math.max(0, Math.min(100, score))
}

function upgradeFinancingInterest(
  existing: FinancialSignals['financing_interest'] | undefined,
  incoming: FinancialSignals['financing_interest'] | undefined
): FinancialSignals['financing_interest'] {
  const levels = { low: 1, medium: 2, high: 3 }
  const existLevel = existing ? levels[existing] ?? 0 : 0
  const incomLevel = incoming ? levels[incoming] ?? 0 : 0
  const maxLevel = Math.max(existLevel, incomLevel)
  if (maxLevel === 3) return 'high'
  if (maxLevel === 2) return 'medium'
  if (maxLevel === 1) return 'low'
  return existing ?? incoming ?? null
}
