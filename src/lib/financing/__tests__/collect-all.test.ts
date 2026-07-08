import { describe, it, expect, vi } from 'vitest'
import { mapToPrequalOffer, runCollectAllPrequal } from '@/lib/financing/collect-all'
import type { PaymentEstimate, LenderApplicationResponse } from '@/lib/financing/types'

const estimates = (slug: any): PaymentEstimate[] => ([
  { lender_slug: slug, lender_name: 'X', monthly_payment: 700, financed_amount: 15000, down_payment: 0, apr: 9.99, term_months: 24, promo_period_months: 0 },
  { lender_slug: slug, lender_name: 'X', monthly_payment: 1250, financed_amount: 15000, down_payment: 0, apr: 0, term_months: 12, promo_period_months: 12 },
])

describe('mapToPrequalOffer', () => {
  it('maps an approved soft-pull + estimate menu into an approved offer with terms[]', () => {
    const resp: LenderApplicationResponse = { status: 'approved', external_id: 'x', approved_amount: 15000 }
    const offer = mapToPrequalOffer('cherry', 'Cherry', resp, estimates('cherry'))
    expect(offer.decision).toBe('approved')
    expect(offer.approved_amount).toBe(15000)
    expect(offer.terms).toHaveLength(2)
    expect(offer.terms.map(t => t.term_months).sort((a, b) => a - b)).toEqual([12, 24])
  })

  it('maps a denial to a declined offer with no terms', () => {
    const offer = mapToPrequalOffer('affirm', 'Affirm', { status: 'denied', external_id: null }, [])
    expect(offer.decision).toBe('declined')
    expect(offer.approved_amount).toBe(0)
    expect(offer.terms).toHaveLength(0)
  })

  it('maps a link-only lender (no prequal response) to an estimate offer', () => {
    const offer = mapToPrequalOffer('proceed', 'Proceed Finance', null, estimates('proceed'))
    expect(offer.decision).toBe('estimate')
    expect(offer.approved_amount).toBe(0)
    expect(offer.terms).toHaveLength(2)
  })
})

describe('runCollectAllPrequal', () => {
  it('fans out across active lenders, isolates a failing lender, and persists offers', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const lenders = [
      { slug: 'cherry' as const, name: 'Cherry',
        preQualify: async () => ({ status: 'approved', external_id: 'a', approved_amount: 15000 } as LenderApplicationResponse),
        getPaymentEstimate: async () => estimates('cherry') },
      { slug: 'proceed' as const, name: 'Proceed Finance',
        preQualify: undefined,
        getPaymentEstimate: async () => estimates('proceed') },
      { slug: 'affirm' as const, name: 'Affirm',
        preQualify: async () => { throw new Error('boom') },
        getPaymentEstimate: async () => estimates('affirm') },
    ]
    const result = await runCollectAllPrequal({
      leadId: 'lead-1', organizationId: 'org-1', requestedAmount: 45000,
      lenders, persist,
    })
    expect(result.offers).toHaveLength(3)
    expect(result.offers.find(o => o.lender_slug === 'cherry')!.decision).toBe('approved')
    expect(result.offers.find(o => o.lender_slug === 'proceed')!.decision).toBe('estimate')
    expect(result.offers.find(o => o.lender_slug === 'affirm')!.decision).toBe('estimate')
    expect(persist).toHaveBeenCalledOnce()
    expect(result.plan.total_loan).toBeGreaterThan(0)
    expect(result.run_id).toBeTruthy()
  })
})
