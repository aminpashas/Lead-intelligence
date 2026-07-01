import { describe, it, expect } from 'vitest'
import { checkSendWindow } from '@/lib/campaigns/send-window'

// All-days window so weekday never affects the hour-boundary assertions.
const win = (over: Partial<{ start_hour: number; end_hour: number; timezone: string; days: number[] }> = {}) => ({
  start_hour: 9,
  end_hour: 20,
  timezone: 'America/New_York',
  days: [0, 1, 2, 3, 4, 5, 6],
  ...over,
})

describe('checkSendWindow — DST-safe hour gating', () => {
  it('no window means always allowed', () => {
    expect(checkSendWindow(null).allowed).toBe(true)
  })

  it('winter (EST, UTC-5): 14:00 UTC = 09:00 local → allowed; 13:00 UTC = 08:00 → blocked', () => {
    expect(checkSendWindow(win(), new Date('2026-01-05T14:00:00Z')).allowed).toBe(true)
    expect(checkSendWindow(win(), new Date('2026-01-05T13:00:00Z')).allowed).toBe(false)
  })

  it('summer (EDT, UTC-4): the SAME 13:00 UTC is 09:00 local → allowed (old code drifted here)', () => {
    // Identical UTC hour to the winter "blocked" case, but DST makes it 09:00 local.
    expect(checkSendWindow(win(), new Date('2026-07-06T13:00:00Z')).allowed).toBe(true)
  })

  it('end hour is exclusive: 19:00 local allowed, 20:00 local blocked', () => {
    expect(checkSendWindow(win(), new Date('2026-01-06T00:00:00Z')).allowed).toBe(true) // 19:00 EST
    expect(checkSendWindow(win(), new Date('2026-01-06T01:00:00Z')).allowed).toBe(false) // 20:00 EST
  })

  it('blocks disallowed days and returns a future nextValidTime', () => {
    const w = win({ days: [1, 2, 3, 4, 5] }) // weekdays only
    const sundayInWindow = new Date('2026-01-04T15:00:00Z') // Sun 10:00 EST — in-hours but Sunday
    const r = checkSendWindow(w, sundayInWindow)
    expect(r.allowed).toBe(false)
    expect(r.nextValidTime).toBeInstanceOf(Date)
    expect(r.nextValidTime!.getTime()).toBeGreaterThan(sundayInWindow.getTime())
  })

  it('before start hour on an allowed day defers to a future time', () => {
    const early = new Date('2026-01-05T12:00:00Z') // Mon 07:00 EST
    const r = checkSendWindow(win(), early)
    expect(r.allowed).toBe(false)
    expect(r.nextValidTime!.getTime()).toBeGreaterThan(early.getTime())
  })
})
