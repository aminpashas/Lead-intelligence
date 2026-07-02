import { describe, it, expect } from 'vitest'
import { zonedTimeToUtc, getZonedParts } from '@/lib/booking/timezone'

// The whole point of these helpers: a practice sets hours in ITS timezone
// (e.g. "3 PM"), but appointments are stored as absolute UTC instants. These
// must be DST-correct — the same wall-clock time maps to a different UTC
// instant in summer vs winter.

describe('zonedTimeToUtc', () => {
  it('converts a summer (PDT, UTC-7) wall time to the correct UTC instant', () => {
    // 2026-07-07 15:00 America/Los_Angeles is PDT (UTC-7) → 22:00 UTC
    const utc = zonedTimeToUtc('2026-07-07', '15:00', 'America/Los_Angeles')
    expect(utc.toISOString()).toBe('2026-07-07T22:00:00.000Z')
  })

  it('converts a winter (PST, UTC-8) wall time to the correct UTC instant', () => {
    // 2026-01-07 15:00 America/Los_Angeles is PST (UTC-8) → 23:00 UTC
    const utc = zonedTimeToUtc('2026-01-07', '15:00', 'America/Los_Angeles')
    expect(utc.toISOString()).toBe('2026-01-07T23:00:00.000Z')
  })

  it('handles a New York timezone independent of the machine timezone', () => {
    // 2026-07-07 09:00 America/New_York is EDT (UTC-4) → 13:00 UTC
    const utc = zonedTimeToUtc('2026-07-07', '09:00', 'America/New_York')
    expect(utc.toISOString()).toBe('2026-07-07T13:00:00.000Z')
  })
})

describe('getZonedParts', () => {
  it('returns the wall-clock parts of a UTC instant in the target timezone', () => {
    // 22:00 UTC on 2026-07-07 is 15:00 PDT, a Tuesday (weekday 2)
    const parts = getZonedParts(new Date('2026-07-07T22:00:00.000Z'), 'America/Los_Angeles')
    expect(parts).toEqual({ year: 2026, month: 7, day: 7, weekday: 2, hour: 15, minute: 0 })
  })

  it('rolls the date back across the UTC/local day boundary', () => {
    // 05:00 UTC on 2026-07-08 is 22:00 PDT on 2026-07-07 (previous day)
    const parts = getZonedParts(new Date('2026-07-08T05:00:00.000Z'), 'America/Los_Angeles')
    expect(parts).toEqual({ year: 2026, month: 7, day: 7, weekday: 2, hour: 22, minute: 0 })
  })
})
