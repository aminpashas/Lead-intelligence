import { describe, it, expect } from 'vitest'
import {
  zonedDayDivider,
  zonedDateLabel,
  zonedDateTimeLabel,
} from '@/lib/time/zoned'

const TZ = 'America/Los_Angeles'

// Regression: imported GHL history from a prior year rendered without the year,
// so a July 29, 2025 thread showed "Tuesday, Jul 29" while "today" was
// July 12, 2026 — reading as a date 17 days in the FUTURE. Any label for a day
// outside the current year must carry the year.
describe('zonedDayDivider', () => {
  // "now" pinned to 2026-07-12 noon Pacific
  const now = new Date('2026-07-12T19:00:00Z')

  it('labels a prior-year day with its year', () => {
    const instant = new Date('2025-07-29T20:57:00Z') // Tue Jul 29 2025, 1:57 PM PDT
    expect(zonedDayDivider(instant, TZ, now)).toBe('Tuesday, Jul 29, 2025')
  })

  it('keeps the short form for current-year days', () => {
    const instant = new Date('2026-07-01T19:00:00Z') // Wed Jul 1 2026
    expect(zonedDayDivider(instant, TZ, now)).toBe('Wednesday, Jul 1')
  })

  it('still says Today / Yesterday', () => {
    expect(zonedDayDivider(new Date('2026-07-12T15:00:00Z'), TZ, now)).toBe('Today')
    expect(zonedDayDivider(new Date('2026-07-11T15:00:00Z'), TZ, now)).toBe('Yesterday')
  })

  it('computes the year boundary in the practice timezone, not UTC', () => {
    // 2026-01-01 03:00 UTC is still Dec 31, 2025 in Pacific — needs the year.
    const instant = new Date('2026-01-01T03:00:00Z')
    expect(zonedDayDivider(instant, TZ, now)).toBe('Wednesday, Dec 31, 2025')
  })
})

describe('zonedDateLabel', () => {
  const now = new Date('2026-07-12T19:00:00Z')

  it('includes the year for other years', () => {
    expect(zonedDateLabel(new Date('2025-07-29T20:57:00Z'), TZ, now)).toBe('Jul 29, 2025')
  })

  it('omits the year within the current year', () => {
    expect(zonedDateLabel(new Date('2026-07-05T19:00:00Z'), TZ, now)).toBe('Jul 5')
  })
})

describe('zonedDateTimeLabel', () => {
  const now = new Date('2026-07-12T19:00:00Z')

  it('includes the year for other years', () => {
    expect(zonedDateTimeLabel(new Date('2025-07-29T20:57:00Z'), TZ, now)).toBe(
      'Jul 29, 2025, 1:57 PM'
    )
  })

  it('omits the year within the current year', () => {
    expect(zonedDateTimeLabel(new Date('2026-07-05T16:56:00Z'), TZ, now)).toBe(
      'Jul 5, 9:56 AM'
    )
  })
})
