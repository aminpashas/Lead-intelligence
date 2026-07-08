import { describe, it, expect } from 'vitest'
import {
  applyReconciliation, computeCheckoutProgress,
  type CheckoutSession,
} from '@/lib/financing/checkout-session'

const term = { apr: 9.9, term_months: 60, promo_period_months: 0 }
const session = (): CheckoutSession => ({
  treatment_total: 45000,
  sub_apps: [
    { lender_slug: 'proceed', lender_name: 'Proceed Finance', requested_amount: 20000, term, status: 'link_sent', funded_amount: 0, confirmed_by: null },
    { lender_slug: 'cherry', lender_name: 'Cherry', requested_amount: 15000, term, status: 'link_sent', funded_amount: 0, confirmed_by: null },
    { lender_slug: 'carecredit', lender_name: 'CareCredit', requested_amount: 10000, term, status: 'selected', funded_amount: 0, confirmed_by: null },
  ],
})

describe('computeCheckoutProgress', () => {
  it('reports nothing funded and all lenders outstanding at the start', () => {
    const p = computeCheckoutProgress(session())
    expect(p.funded_total).toBe(0)
    expect(p.outstanding_lenders).toHaveLength(3)
    expect(p.is_complete).toBe(false)
    expect(p.status).toBe('in_progress')
  })

  it('sums funded amounts and completes when the total is covered', () => {
    let s = session()
    s = applyReconciliation(s, { lender_slug: 'proceed', status: 'funded', funded_amount: 20000, confirmed_by: 'staff' })
    s = applyReconciliation(s, { lender_slug: 'cherry', status: 'funded', funded_amount: 15000, confirmed_by: 'patient' })
    s = applyReconciliation(s, { lender_slug: 'carecredit', status: 'funded', funded_amount: 10000, confirmed_by: 'staff' })
    const p = computeCheckoutProgress(s)
    expect(p.funded_total).toBe(45000)
    expect(p.covered).toBe(45000)
    expect(p.outstanding_total).toBe(0)
    expect(p.outstanding_lenders).toHaveLength(0)
    expect(p.is_complete).toBe(true)
    expect(p.status).toBe('complete')
  })

  it('keeps the shortfall outstanding when a lender is declined', () => {
    let s = session()
    s = applyReconciliation(s, { lender_slug: 'proceed', status: 'funded', funded_amount: 20000, confirmed_by: 'staff' })
    s = applyReconciliation(s, { lender_slug: 'cherry', status: 'declined', confirmed_by: 'staff' })
    const p = computeCheckoutProgress(s)
    expect(p.funded_total).toBe(20000)
    expect(p.outstanding_total).toBe(25000)
    expect(p.outstanding_lenders.map(l => l.lender_slug)).toEqual(['carecredit'])
    expect(p.is_complete).toBe(false)
  })

  it('is immutable — applyReconciliation returns a new session', () => {
    const s0 = session()
    const s1 = applyReconciliation(s0, { lender_slug: 'proceed', status: 'started', confirmed_by: 'patient' })
    expect(s0.sub_apps[0].status).toBe('link_sent')
    expect(s1.sub_apps[0].status).toBe('started')
  })
})
