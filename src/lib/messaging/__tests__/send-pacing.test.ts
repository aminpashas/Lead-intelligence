import { describe, it, expect } from 'vitest'
import { computeHumanSendDelayMs } from '@/lib/messaging/send-pacing'

describe('computeHumanSendDelayMs', () => {
  it('never sends faster than the floor or slower than the ceiling', () => {
    // rand=0 pulls the jitter to its minimum; rand=1 to its maximum.
    const shortFast = computeHumanSendDelayMs('ok', { rand: () => 0 })
    const longSlow = computeHumanSendDelayMs('x'.repeat(2000), { rand: () => 1 })
    expect(shortFast).toBeGreaterThanOrEqual(20_000)
    expect(longSlow).toBeLessThanOrEqual(90_000)
  })

  it('scales with reply length — a longer reply takes longer to "type"', () => {
    const short = computeHumanSendDelayMs('yep', { rand: () => 0.5 })
    const long = computeHumanSendDelayMs(
      'Absolutely — I can walk you through the whole process and what recovery looks like, no pressure at all.',
      { rand: () => 0.5 }
    )
    expect(long).toBeGreaterThan(short)
  })

  it('is deterministic given a fixed rand', () => {
    const a = computeHumanSendDelayMs('same message here', { rand: () => 0.42 })
    const b = computeHumanSendDelayMs('same message here', { rand: () => 0.42 })
    expect(a).toBe(b)
  })

  it('jitter separates two equal-length replies in the unclamped band', () => {
    // Long enough that the raw delay sits between the 20s floor and 90s ceiling,
    // so jitter is visible rather than clamped away.
    const msg =
      'That makes total sense, and I completely understand wanting to take your time with a decision this big for your health.'
    const low = computeHumanSendDelayMs(msg, { rand: () => 0.1 })
    const high = computeHumanSendDelayMs(msg, { rand: () => 0.9 })
    expect(low).not.toBe(high)
  })

  it('respects custom bounds', () => {
    const d = computeHumanSendDelayMs('hi', { minMs: 1000, maxMs: 2000, rand: () => 0 })
    expect(d).toBeGreaterThanOrEqual(1000)
    expect(d).toBeLessThanOrEqual(2000)
  })
})
