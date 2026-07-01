import { describe, it, expect } from 'vitest'
import {
  computeReactivationFunnel,
  isReactivatedLeadStatus,
} from '@/lib/campaigns/reconcile-reactivation'

describe('isReactivatedLeadStatus', () => {
  it('treats active-pipeline statuses as reactivated', () => {
    for (const s of ['consultation_scheduled', 'treatment_presented', 'contract_signed', 'completed']) {
      expect(isReactivatedLeadStatus(s)).toBe(true)
    }
  })
  it('does not treat cold/early statuses as reactivated', () => {
    for (const s of ['new', 'contacted', 'qualified', 'dormant', 'unresponsive', 'lost', null, undefined]) {
      expect(isReactivatedLeadStatus(s as string)).toBe(false)
    }
  })
})

describe('computeReactivationFunnel', () => {
  it('counts responded, reactivated, and converted independently', () => {
    const f = computeReactivationFunnel([
      // replied, re-engaged, and closed
      { status: 'contract_signed', total_messages_received: 3 },
      // replied and re-engaged, not yet converted
      { status: 'consultation_scheduled', total_messages_received: 1 },
      // replied only, still cold
      { status: 'contacted', total_messages_received: 2 },
      // no reply, no re-engagement
      { status: 'dormant', total_messages_received: 0 },
    ])
    expect(f.responded).toBe(3)
    expect(f.reactivated).toBe(2)
    expect(f.converted).toBe(1)
  })

  it('converted is always a subset of reactivated', () => {
    const f = computeReactivationFunnel([
      { status: 'completed', total_messages_received: 0 }, // converted w/o a tracked reply
    ])
    expect(f.converted).toBe(1)
    expect(f.reactivated).toBe(1)
    expect(f.responded).toBe(0)
  })

  it('returns all zeros for an untouched dormant cohort', () => {
    const f = computeReactivationFunnel([
      { status: 'dormant', total_messages_received: 0 },
      { status: 'unresponsive', total_messages_received: null },
    ])
    expect(f).toEqual({ responded: 0, reactivated: 0, converted: 0 })
  })
})
