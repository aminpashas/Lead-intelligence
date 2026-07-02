import { describe, it, expect } from 'vitest'
import { summarizeSpendRows, type SpendRow } from '@/lib/billing/spend-summary'

describe('summarizeSpendRows', () => {
  it('returns zeros for no rows', () => {
    const s = summarizeSpendRows([])
    expect(s.totalCostCents).toBe(0)
    expect(s.totalBillableCents).toBe(0)
    expect(s.marginCents).toBe(0)
    expect(s.byService).toEqual({})
    expect(s.byOrg).toEqual({})
  })

  it('rolls up totals, margin, per-service, and per-org', () => {
    const rows: SpendRow[] = [
      { organizationId: 'A', service: 'ai', costCents: 10, billableCents: 15 },
      { organizationId: 'A', service: 'sms', costCents: 4, billableCents: 5.6 },
      { organizationId: 'B', service: 'ai', costCents: 20, billableCents: 30 },
      { organizationId: 'B', service: 'voice', costCents: 100, billableCents: 130 },
    ]
    const s = summarizeSpendRows(rows)

    expect(s.totalCostCents).toBeCloseTo(134, 6)
    expect(s.totalBillableCents).toBeCloseTo(180.6, 6)
    expect(s.marginCents).toBeCloseTo(46.6, 6) // billable - cost

    expect(s.byService.ai).toEqual({ costCents: 30, billableCents: 45 })
    expect(s.byService.sms).toEqual({ costCents: 4, billableCents: 5.6 })
    expect(s.byService.voice).toEqual({ costCents: 100, billableCents: 130 })

    expect(s.byOrg.A).toEqual({ costCents: 14, billableCents: 20.6 })
    expect(s.byOrg.B).toEqual({ costCents: 120, billableCents: 160 })
  })
})
