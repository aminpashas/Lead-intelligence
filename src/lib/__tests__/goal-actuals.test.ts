import { describe, it, expect } from 'vitest'
import { actualForMetric, type ActualLead } from '@/lib/goals/actuals'

const START = '2026-01-01T00:00:00Z'
const END = '2026-12-31T23:59:59Z'

function lead(o: Partial<ActualLead>): ActualLead {
  return {
    status: 'qualified',
    ai_qualification: 'warm',
    treatment_value: null,
    actual_revenue: null,
    created_at: null,
    converted_at: null,
    consultation_date: null,
    ...o,
  }
}

describe('actualForMetric', () => {
  it('pipeline_value sums treatment_value excluding lost/disqualified', () => {
    const leads = [
      lead({ treatment_value: 20000, status: 'qualified' }),
      lead({ treatment_value: 15000, status: 'lost' }),
      lead({ treatment_value: 5000, status: 'disqualified' }),
      lead({ treatment_value: 10000, status: 'completed' }),
    ]
    expect(actualForMetric(leads, 'pipeline_value', START, END)).toBe(30000)
  })

  it('conversions counts leads converted within the period', () => {
    const leads = [
      lead({ converted_at: '2026-03-01T00:00:00Z' }),
      lead({ converted_at: '2025-12-01T00:00:00Z' }), // before period
      lead({ converted_at: null }),
    ]
    expect(actualForMetric(leads, 'conversions', START, END)).toBe(1)
  })

  it('revenue sums actual_revenue for in-period conversions', () => {
    const leads = [
      lead({ converted_at: '2026-03-01T00:00:00Z', actual_revenue: 18000 }),
      lead({ converted_at: '2026-06-01T00:00:00Z', actual_revenue: 22000 }),
      lead({ converted_at: '2025-01-01T00:00:00Z', actual_revenue: 99999 }),
    ]
    expect(actualForMetric(leads, 'revenue', START, END)).toBe(40000)
  })

  it('bookings counts in-period consultation dates', () => {
    const leads = [
      lead({ consultation_date: '2026-02-02T00:00:00Z' }),
      lead({ consultation_date: '2027-01-01T00:00:00Z' }),
    ]
    expect(actualForMetric(leads, 'bookings', START, END)).toBe(1)
  })

  it('qualification_rate = qualified / created-in-period * 100', () => {
    const leads = [
      lead({ created_at: '2026-02-01T00:00:00Z', ai_qualification: 'hot' }),
      lead({ created_at: '2026-02-02T00:00:00Z', ai_qualification: 'unqualified' }),
      lead({ created_at: '2026-02-03T00:00:00Z', ai_qualification: 'warm' }),
      lead({ created_at: '2025-02-03T00:00:00Z', ai_qualification: 'hot' }), // before period, ignored
    ]
    // 2 of 3 in-period are qualified
    expect(Math.round(actualForMetric(leads, 'qualification_rate', START, END))).toBe(67)
  })

  it('qualification_rate is 0 with no in-period leads', () => {
    expect(actualForMetric([], 'qualification_rate', START, END)).toBe(0)
  })
})
