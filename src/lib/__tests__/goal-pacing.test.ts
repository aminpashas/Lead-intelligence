import { describe, it, expect } from 'vitest'
import { computeGoalProgress } from '@/lib/goals/pacing'

const PERIOD = { periodStart: '2026-01-01T00:00:00Z', periodEnd: '2026-12-31T00:00:00Z' }
const MID = '2026-07-02T00:00:00Z' // ~half the year elapsed

describe('computeGoalProgress', () => {
  it('no_data when target is non-positive', () => {
    expect(computeGoalProgress({ target: 0, actual: 5, ...PERIOD, now: MID }).paceStatus).toBe('no_data')
  })

  it('green when attainment keeps up with time elapsed', () => {
    const r = computeGoalProgress({ target: 100, actual: 50, ...PERIOD, now: MID })
    expect(r.paceStatus).toBe('green')
    expect(r.onPace).toBe(true)
    expect(Math.round(r.pct)).toBe(50)
  })

  it('red when well behind pace', () => {
    const r = computeGoalProgress({ target: 100, actual: 10, ...PERIOD, now: MID })
    expect(r.paceStatus).toBe('red')
    expect(r.onPace).toBe(false)
  })

  it('yellow in the warning band (~80-99% of pace)', () => {
    // half elapsed → expected 50; actual 42 → ratio 0.84 → yellow
    const r = computeGoalProgress({ target: 100, actual: 42, ...PERIOD, now: MID })
    expect(r.paceStatus).toBe('yellow')
  })

  it('green before the period starts (nothing to be behind on)', () => {
    const r = computeGoalProgress({ target: 100, actual: 0, ...PERIOD, now: '2025-06-01T00:00:00Z' })
    expect(r.paceStatus).toBe('green')
    expect(r.onPace).toBe(true)
  })

  it('exceeding target is green', () => {
    const r = computeGoalProgress({ target: 100, actual: 120, ...PERIOD, now: MID })
    expect(r.paceStatus).toBe('green')
    expect(r.pct).toBe(120)
  })
})
