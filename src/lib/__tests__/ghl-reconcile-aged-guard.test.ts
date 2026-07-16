import { describe, it, expect } from 'vitest'
import { isAgedForNewStage } from '@/lib/ghl/reconcile'

const NOW = new Date('2026-07-16T00:00:00.000Z')
const iso = (daysAgo: number) =>
  new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString()

/**
 * The guard that stops the nightly tug-of-war: GHL's "AOX Nurturing Database"
 * pipeline names its intake stage "New Lead", so every sweep maps a months-old
 * cold import onto `new`. Freshness is LI's fact (created_at), not GHL's.
 */
describe('isAgedForNewStage', () => {
  it('is false for a genuinely fresh lead (inside the window)', () => {
    expect(isAgedForNewStage(iso(0), NOW, 7)).toBe(false)
    expect(isAgedForNewStage(iso(1), NOW, 7)).toBe(false)
    expect(isAgedForNewStage(iso(6.9), NOW, 7)).toBe(false)
  })

  it('is true for the cold-import cohort (well outside the window)', () => {
    // The SF AOX Nurturing Database rows are ~41 days old.
    expect(isAgedForNewStage(iso(41), NOW, 7)).toBe(true)
    expect(isAgedForNewStage(iso(8), NOW, 7)).toBe(true)
  })

  it('treats the boundary as still-new (only strictly older is aged)', () => {
    expect(isAgedForNewStage(iso(7), NOW, 7)).toBe(false)
    expect(isAgedForNewStage(iso(7.01), NOW, 7)).toBe(true)
  })

  it('honours a custom window', () => {
    expect(isAgedForNewStage(iso(10), NOW, 14)).toBe(false)
    expect(isAgedForNewStage(iso(20), NOW, 14)).toBe(true)
  })

  // Fail-safe, matching the reconcile-map's "never guess" posture: an unknown or
  // corrupt age must not cause a lead to be silently withheld from New Lead.
  it('never guesses when the age is unknown or unparseable', () => {
    expect(isAgedForNewStage(null, NOW, 7)).toBe(false)
    expect(isAgedForNewStage('not-a-date', NOW, 7)).toBe(false)
    expect(isAgedForNewStage('', NOW, 7)).toBe(false)
  })

  it('a future created_at is never aged', () => {
    expect(isAgedForNewStage(iso(-5), NOW, 7)).toBe(false)
  })
})
