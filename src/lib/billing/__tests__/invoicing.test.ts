import { describe, it, expect } from 'vitest'
import { currentMonthPeriod, previousMonthPeriod } from '@/lib/billing/invoicing'

describe('currentMonthPeriod', () => {
  it('returns the first of the month → first of next month (UTC, exclusive end)', () => {
    expect(currentMonthPeriod(new Date('2026-07-04T18:00:00Z'))).toEqual({
      periodStart: '2026-07-01',
      periodEnd: '2026-08-01',
    })
  })

  it('rolls the year at December', () => {
    expect(currentMonthPeriod(new Date('2026-12-15T00:00:00Z'))).toEqual({
      periodStart: '2026-12-01',
      periodEnd: '2027-01-01',
    })
  })
})

describe('previousMonthPeriod', () => {
  it('returns the whole prior calendar month (what the monthly cron bills)', () => {
    expect(previousMonthPeriod(new Date('2026-08-01T08:00:00Z'))).toEqual({
      periodStart: '2026-07-01',
      periodEnd: '2026-08-01',
    })
  })

  it('rolls the year back at January', () => {
    expect(previousMonthPeriod(new Date('2027-01-01T08:00:00Z'))).toEqual({
      periodStart: '2026-12-01',
      periodEnd: '2027-01-01',
    })
  })
})
