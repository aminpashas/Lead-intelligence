import { describe, it, expect } from 'vitest'
import {
  buildFinancingBreakdown,
  generateAmortizationSchedule,
  calculateAffordabilityRatio,
  type BreakdownOptions,
} from '@/lib/financing/calculator'

// ═══════════════════════════════════════════════════════════════
// generateAmortizationSchedule
// ═══════════════════════════════════════════════════════════════

describe('generateAmortizationSchedule', () => {
  it('generates a simple 0% APR schedule', () => {
    const schedule = generateAmortizationSchedule(1200, 0, 12)

    expect(schedule).toHaveLength(12)
    // All interest should be 0
    schedule.forEach((row) => {
      expect(row.interest).toBe(0)
    })
    // First 11 payments should be equal, last adjusts for rounding
    const totalPaid = schedule.reduce((sum, r) => sum + r.payment, 0)
    expect(totalPaid).toBeCloseTo(1200, 0)
    // Final balance should be 0
    expect(schedule[schedule.length - 1].balance).toBe(0)
  })

  it('generates a standard amortization with interest', () => {
    const schedule = generateAmortizationSchedule(10000, 10, 24)

    expect(schedule).toHaveLength(24)
    // First row should have non-zero interest
    expect(schedule[0].interest).toBeGreaterThan(0)
    // Payments should include both principal and interest
    expect(schedule[0].principal).toBeGreaterThan(0)
    // Final balance should be ~0
    expect(schedule[schedule.length - 1].balance).toBeCloseTo(0, 1)
    // Total paid should be more than principal
    const totalPaid = schedule.reduce((sum, r) => sum + r.payment, 0)
    expect(totalPaid).toBeGreaterThan(10000)
  })

  it('handles a promotional period followed by standard APR', () => {
    const schedule = generateAmortizationSchedule(12000, 17.9, 24, 6)

    expect(schedule).toHaveLength(24)
    // First 6 months: promo (0% interest)
    for (let i = 0; i < 6; i++) {
      expect(schedule[i].is_promo).toBe(true)
      expect(schedule[i].interest).toBe(0)
    }
    // Remaining months: standard APR
    for (let i = 6; i < 24; i++) {
      expect(schedule[i].is_promo).toBe(false)
      expect(schedule[i].interest).toBeGreaterThanOrEqual(0)
    }
  })

  it('handles entire term as promotional period', () => {
    const schedule = generateAmortizationSchedule(6000, 17.9, 6, 6)

    expect(schedule).toHaveLength(6)
    schedule.forEach((row) => {
      expect(row.is_promo).toBe(true)
      expect(row.interest).toBe(0)
    })
    const totalPaid = schedule.reduce((sum, r) => sum + r.payment, 0)
    expect(totalPaid).toBeCloseTo(6000, 0)
  })

  it('handles promo_months > term_months (all promo)', () => {
    const schedule = generateAmortizationSchedule(3000, 10, 6, 12)

    expect(schedule).toHaveLength(6)
    schedule.forEach((row) => {
      expect(row.is_promo).toBe(true)
      expect(row.interest).toBe(0)
    })
  })

  it('ensures month numbers are sequential', () => {
    const schedule = generateAmortizationSchedule(5000, 12, 12, 3)

    schedule.forEach((row, idx) => {
      expect(row.month).toBe(idx + 1)
    })
  })

  it('handles zero principal', () => {
    const schedule = generateAmortizationSchedule(0, 10, 12)
    // No payments needed
    expect(schedule).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════
// calculateAffordabilityRatio
// ═══════════════════════════════════════════════════════════════

describe('calculateAffordabilityRatio', () => {
  it('calculates correct percentage of monthly income', () => {
    // $500/mo payment on $60,000 annual income = 10%
    const ratio = calculateAffordabilityRatio(500, 60000)
    expect(ratio).toBe(10)
  })

  it('returns 0 when no income provided', () => {
    expect(calculateAffordabilityRatio(300)).toBe(0)
  })

  it('returns 0 when income is zero', () => {
    expect(calculateAffordabilityRatio(300, 0)).toBe(0)
  })

  it('returns 0 when income is negative', () => {
    expect(calculateAffordabilityRatio(300, -50000)).toBe(0)
  })

  it('handles large payment relative to income', () => {
    // $2500/mo on $30000/yr = 100%
    const ratio = calculateAffordabilityRatio(2500, 30000)
    expect(ratio).toBe(100)
  })
})

// ═══════════════════════════════════════════════════════════════
// buildFinancingBreakdown
// ═══════════════════════════════════════════════════════════════

describe('buildFinancingBreakdown', () => {
  describe('deductions', () => {
    it('calculates total deductions correctly', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 25000,
        insurance_estimate: 2000,
        patient_cash: 3000,
        hsa_fsa: 1000,
        other_credits: 500,
      })

      expect(result.deductions.insurance_estimate).toBe(2000)
      expect(result.deductions.patient_cash).toBe(3000)
      expect(result.deductions.hsa_fsa).toBe(1000)
      expect(result.deductions.other_credits).toBe(500)
      expect(result.deductions.total_deductions).toBe(6500)
      expect(result.amount_to_finance).toBe(18500)
    })

    it('defaults hsa_fsa and other_credits to 0', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 10000,
        insurance_estimate: 0,
        patient_cash: 0,
      })

      expect(result.deductions.hsa_fsa).toBe(0)
      expect(result.deductions.other_credits).toBe(0)
    })

    it('clamps amount_to_finance to zero when deductions exceed treatment value', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 5000,
        insurance_estimate: 3000,
        patient_cash: 3000,
      })

      expect(result.amount_to_finance).toBe(0)
    })
  })

  describe('insurance estimation', () => {
    it('estimates insurance coverage when has_dental_insurance is true', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 30000,
        has_dental_insurance: true,
      })

      // Min(2000, 30000 * 0.1) = Min(2000, 3000) = 2000
      expect(result.deductions.insurance_estimate).toBe(2000)
    })

    it('sets insurance to 0 when has_dental_insurance is false', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 30000,
        has_dental_insurance: false,
      })

      expect(result.deductions.insurance_estimate).toBe(0)
    })

    it('sets insurance to 0 when has_dental_insurance is null', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 30000,
        has_dental_insurance: null,
      })

      expect(result.deductions.insurance_estimate).toBe(0)
    })

    it('caps insurance at $2000 even for expensive treatments', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 100000,
        has_dental_insurance: true,
      })

      expect(result.deductions.insurance_estimate).toBe(2000)
    })

    it('calculates 10% for lower treatment values', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 10000,
        has_dental_insurance: true,
      })

      // Min(2000, 10000 * 0.1) = Min(2000, 1000) = 1000
      expect(result.deductions.insurance_estimate).toBe(1000)
    })
  })

  describe('budget range down payment', () => {
    it('maps budget ranges to appropriate down payments', () => {
      const ranges = [
        ['under_10k', 1000],
        ['10k_15k', 1500],
        ['15k_20k', 2000],
        ['20k_25k', 2500],
        ['25k_30k', 3000],
        ['over_30k', 4000],
      ] as const

      for (const [range, expected] of ranges) {
        const result = buildFinancingBreakdown({
          treatment_value: 30000,
          insurance_estimate: 0,
          budget_range: range,
        })
        expect(result.deductions.patient_cash).toBe(expected)
      }
    })

    it('defaults to 0 down payment with no budget range', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 20000,
        insurance_estimate: 0,
      })

      expect(result.deductions.patient_cash).toBe(0)
    })
  })

  describe('scenarios', () => {
    it('generates scenarios from default lenders', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 15000,
        insurance_estimate: 0,
        patient_cash: 0,
      })

      expect(result.scenarios.length).toBeGreaterThan(0)
      // Each scenario should have required fields
      result.scenarios.forEach((s) => {
        expect(s.financed_amount).toBe(15000)
        expect(s.monthly_payment).toBeGreaterThan(0)
        expect(s.term_months).toBeGreaterThan(0)
        expect(s.lender_name).toBeTruthy()
      })
    })

    it('filters to only specified active_lenders', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 10000,
        insurance_estimate: 0,
        patient_cash: 0,
        active_lenders: ['sunbit'],
      })

      result.scenarios.forEach((s) => {
        expect(s.lender_slug).toBe('sunbit')
      })
    })

    it('sorts scenarios by monthly payment ascending', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 20000,
        insurance_estimate: 0,
        patient_cash: 0,
      })

      for (let i = 1; i < result.scenarios.length; i++) {
        expect(result.scenarios[i].monthly_payment).toBeGreaterThanOrEqual(
          result.scenarios[i - 1].monthly_payment
        )
      }
    })

    it('includes biweekly details for each scenario', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 15000,
        insurance_estimate: 0,
        patient_cash: 0,
        active_lenders: ['proceed'],
      })

      result.scenarios.forEach((s) => {
        expect(s.biweekly).toBeDefined()
        expect(s.biweekly.biweekly_payment).toBeGreaterThan(0)
      })
    })

    it('returns no scenarios when amount_to_finance is 0', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 5000,
        insurance_estimate: 3000,
        patient_cash: 3000,
      })

      expect(result.scenarios).toHaveLength(0)
    })
  })

  describe('recommendations', () => {
    it('provides recommendations when scenarios exist', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 20000,
        insurance_estimate: 0,
        patient_cash: 0,
      })

      const rec = result.recommendation
      expect(rec.lowest_monthly).not.toBeNull()
      expect(rec.lowest_total_cost).not.toBeNull()
      expect(rec.shortest_payoff).not.toBeNull()
      expect(rec.best_overall).not.toBeNull()
    })

    it('sets recommendations to null when no scenarios', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 1000,
        insurance_estimate: 1000,
        patient_cash: 1000,
      })

      expect(result.recommendation.lowest_monthly).toBeNull()
      expect(result.recommendation.lowest_total_cost).toBeNull()
      expect(result.recommendation.shortest_payoff).toBeNull()
    })

    it('finds zero-interest options when available', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 10000,
        insurance_estimate: 0,
        patient_cash: 0,
        active_lenders: ['carecredit'],
      })

      // CareCredit has 0% promo tiers
      expect(result.recommendation.zero_interest).not.toBeNull()
      if (result.recommendation.zero_interest) {
        expect(result.recommendation.zero_interest.total_interest).toBe(0)
      }
    })
  })

  describe('lender options', () => {
    it('groups scenarios by lender', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 20000,
        insurance_estimate: 0,
        patient_cash: 0,
      })

      expect(result.lender_options.length).toBeGreaterThan(0)
      result.lender_options.forEach((group) => {
        expect(group.lender_slug).toBeTruthy()
        expect(group.lender_name).toBeTruthy()
        expect(group.terms.length).toBeGreaterThan(0)
        expect(group.recommended_tier).toBeTruthy()
        // Terms should be sorted by term_months
        for (let i = 1; i < group.terms.length; i++) {
          expect(group.terms[i].term_months).toBeGreaterThanOrEqual(
            group.terms[i - 1].term_months
          )
        }
      })
    })
  })

  describe('savings tips', () => {
    it('generates savings tips for large financed amounts', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 25000,
        insurance_estimate: 0,
        patient_cash: 0,
        active_lenders: ['proceed'],
      })

      // Should have at least a tax refund lump sum tip for > $10k
      const lumpSumTip = result.savings_tips.find((t) => t.type === 'lump_sum')
      expect(lumpSumTip).toBeDefined()
    })

    it('tips are sorted by savings_amount descending', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 25000,
        insurance_estimate: 0,
        patient_cash: 0,
      })

      for (let i = 1; i < result.savings_tips.length; i++) {
        expect(result.savings_tips[i].savings_amount).toBeLessThanOrEqual(
          result.savings_tips[i - 1].savings_amount
        )
      }
    })
  })

  describe('metadata', () => {
    it('includes generated_at timestamp', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 10000,
        insurance_estimate: 0,
        patient_cash: 0,
      })

      expect(result.generated_at).toBeTruthy()
      // Should be a valid ISO string
      expect(new Date(result.generated_at).getTime()).not.toBeNaN()
    })

    it('stores the treatment_value in the result', () => {
      const result = buildFinancingBreakdown({
        treatment_value: 42000,
        insurance_estimate: 0,
        patient_cash: 0,
      })

      expect(result.treatment_value).toBe(42000)
    })
  })
})
