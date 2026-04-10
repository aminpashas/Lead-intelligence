/**
 * AI-Generated Patient Financing Summary
 *
 * Uses Claude to generate a warm, clear explanation of financing options
 * that front desk staff can share with patients via SMS or email.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { FinancingBreakdown } from './calculator'

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
}

type PatientContext = {
  firstName?: string | null
  dentalCondition?: string | null
}

export async function generatePatientFinancingSummary(
  breakdown: FinancingBreakdown,
  context: PatientContext = {}
): Promise<string> {
  const { treatment_value, deductions, amount_to_finance, recommendation, scenarios } = breakdown

  // Build a concise data summary for the AI
  const bestMonthly = recommendation.lowest_monthly
  const bestTotal = recommendation.lowest_total_cost
  const zeroInterest = recommendation.zero_interest

  // Get unique lenders with their best offers
  const lenderBest = new Map<string, { monthly: number; term: number; apr: number }>()
  for (const s of scenarios) {
    const existing = lenderBest.get(s.lender_name)
    if (!existing || s.monthly_payment < existing.monthly) {
      lenderBest.set(s.lender_name, {
        monthly: s.monthly_payment,
        term: s.term_months,
        apr: s.apr,
      })
    }
  }

  const lenderSummaries = Array.from(lenderBest.entries())
    .slice(0, 5) // Top 5 lenders
    .map(([name, info]) => `${name}: as low as $${info.monthly}/mo (${info.term}mo @ ${info.apr}% APR)`)
    .join('\n')

  const prompt = `Generate a warm, clear financing summary for a dental patient. This will be shared by front desk staff.

Patient: ${context.firstName || 'the patient'}
${context.dentalCondition ? `Procedure: ${context.dentalCondition.replace(/_/g, ' ')} treatment` : 'Procedure: All-on-4 dental implants'}

FINANCIAL BREAKDOWN:
- Treatment cost: $${treatment_value.toLocaleString()}
- Insurance coverage: $${deductions.insurance_estimate.toLocaleString()}
- Patient down payment: $${deductions.patient_cash.toLocaleString()}
${deductions.hsa_fsa > 0 ? `- HSA/FSA: $${deductions.hsa_fsa.toLocaleString()}` : ''}
- Amount to finance: $${amount_to_finance.toLocaleString()}

BEST OPTIONS:
${bestMonthly ? `Lowest monthly: ${bestMonthly.lender_name} - $${bestMonthly.monthly_payment}/mo for ${bestMonthly.term_months} months` : ''}
${bestTotal ? `Lowest total cost: ${bestTotal.lender_name} - $${bestTotal.total_paid} total (${bestTotal.term_months} months)` : ''}
${zeroInterest ? `0% interest option: ${zeroInterest.lender_name} - $${zeroInterest.monthly_payment}/mo for ${zeroInterest.term_months} months` : ''}

ALL LENDER OPTIONS:
${lenderSummaries}

REQUIREMENTS:
- Write 3-4 short paragraphs, warm and professional tone
- Start with the total cost and what's covered
- Explain the amount they'd need to finance after deductions
- Present 2-3 best options with monthly payments
- End with encouragement and next step (schedule consultation or call to discuss)
- Do NOT include specific APR numbers (say "competitive rates" instead)
- Do NOT make it sound like a sales pitch
- Do NOT include any medical claims
- Keep it under 200 words`

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
    system: 'You are a helpful dental practice financial coordinator. Write clear, empathetic explanations of financing options for patients considering dental implant treatment. Never use medical jargon or make treatment promises.',
  })

  return response.content[0].type === 'text' ? response.content[0].text : ''
}
