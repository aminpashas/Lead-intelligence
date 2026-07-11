import { describe, it, expect } from 'vitest'
import {
  closingQueueState,
  isInLiveQueue,
  effectiveTemperature,
} from '@/lib/pipeline/closing'

// Fixed "now" so the tests are deterministic (the module injects nowMs).
const NOW = new Date('2026-07-08T12:00:00Z').getTime()
const inFuture = new Date('2026-07-22T12:00:00Z').toISOString()
const inPast = new Date('2026-06-24T12:00:00Z').toISOString()

describe('closingQueueState', () => {
  it('non-deliberating deals are always active, regardless of any stray timer', () => {
    expect(closingQueueState('hot', null, NOW)).toBe('active')
    expect(closingQueueState('cold', inFuture, NOW)).toBe('active')
    expect(closingQueueState('stalled', inPast, NOW)).toBe('active')
    expect(closingQueueState(null, inFuture, NOW)).toBe('active')
  })

  it('deliberating with a future follow-up date is muted as waiting', () => {
    expect(closingQueueState('deliberating', inFuture, NOW)).toBe('waiting')
  })

  it('deliberating whose follow-up date has arrived is due', () => {
    expect(closingQueueState('deliberating', inPast, NOW)).toBe('due')
    // exactly now counts as due (<=)
    expect(closingQueueState('deliberating', new Date(NOW).toISOString(), NOW)).toBe('due')
  })

  it('deliberating with NO date set is due, not silently hidden', () => {
    expect(closingQueueState('deliberating', null, NOW)).toBe('due')
  })
})

describe('isInLiveQueue', () => {
  it('live queue = active + due; only future-dated deliberators drop out', () => {
    expect(isInLiveQueue('hot', null, NOW)).toBe(true) // active
    expect(isInLiveQueue('deliberating', inPast, NOW)).toBe(true) // due
    expect(isInLiveQueue('deliberating', null, NOW)).toBe(true) // due (no timer)
    expect(isInLiveQueue('deliberating', inFuture, NOW)).toBe(false) // waiting
  })
})

describe('effectiveTemperature', () => {
  it('respects a manual deliberating override instead of deriving', () => {
    // A strong close-probability deal a closer marked deliberating stays that way.
    expect(effectiveTemperature('deliberating', 0.9, 2)).toBe('deliberating')
  })

  it('still derives when no manual override is set', () => {
    expect(effectiveTemperature(null, 0.9, 2)).toBe('hot')
    // silence trumps probability
    expect(effectiveTemperature(null, 0.9, 30)).toBe('stalled')
  })
})
