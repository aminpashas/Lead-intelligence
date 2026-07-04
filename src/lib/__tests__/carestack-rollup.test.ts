import { describe, it, expect } from 'vitest'
import { computeLeadOutcome, type ProcedureForRollup } from '@/lib/ehr/carestack/rollup'

function proc(o: Partial<ProcedureForRollup>): ProcedureForRollup {
  return {
    status_id: 3,
    patient_estimate: 0,
    insurance_estimate: 0,
    date_of_service: null,
    proposed_date: null,
    ...o,
  }
}

describe('computeLeadOutcome', () => {
  it('sums accepted procedures into treatment_value but not actual_revenue', () => {
    const r = computeLeadOutcome([
      proc({ status_id: 3, patient_estimate: 3000, insurance_estimate: 1000 }),
    ])
    expect(r.treatment_value).toBe(4000)
    expect(r.actual_revenue).toBe(0)
  })

  it('counts completed procedures toward both treatment_value and actual_revenue', () => {
    const r = computeLeadOutcome([
      proc({ status_id: 8, patient_estimate: 2500, insurance_estimate: 500 }),
    ])
    expect(r.treatment_value).toBe(3000)
    expect(r.actual_revenue).toBe(3000)
  })

  it('ignores proposed/rejected/other statuses', () => {
    const r = computeLeadOutcome([
      proc({ status_id: 1, patient_estimate: 9999 }), // proposed
      proc({ status_id: 4, patient_estimate: 9999 }), // rejected
      proc({ status_id: 2, patient_estimate: 9999 }), // scheduled
      proc({ status_id: 3, patient_estimate: 1000 }), // accepted — the only one counted
    ])
    expect(r.treatment_value).toBe(1000)
    expect(r.actual_revenue).toBe(0)
  })

  it('takes the earliest date_of_service/proposed_date as converted_at', () => {
    const r = computeLeadOutcome([
      proc({ status_id: 8, patient_estimate: 1000, date_of_service: '2026-05-10T00:00:00Z' }),
      proc({ status_id: 3, patient_estimate: 1000, proposed_date: '2026-03-01T00:00:00Z' }),
    ])
    expect(r.converted_at).toBe('2026-03-01T00:00:00Z')
  })

  it('returns zeros and null for a patient with no accepted/completed work', () => {
    const r = computeLeadOutcome([proc({ status_id: 1, patient_estimate: 5000 })])
    expect(r).toEqual({ treatment_value: 0, actual_revenue: 0, converted_at: null })
  })

  it('handles null estimates without producing NaN', () => {
    const r = computeLeadOutcome([
      proc({ status_id: 8, patient_estimate: null, insurance_estimate: null }),
    ])
    expect(r.treatment_value).toBe(0)
    expect(r.actual_revenue).toBe(0)
  })
})
