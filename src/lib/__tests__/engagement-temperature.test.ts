import { describe, it, expect } from 'vitest'
import {
  computeEngagement,
  HOT_DAYS,
  WARM_DAYS,
  COOLING_DAYS,
  NEW_GRACE_DAYS,
  type EngagementInputs,
} from '@/lib/engagement/temperature'

const NOW = new Date('2026-07-13T12:00:00Z')

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString()
}

function lead(overrides: Partial<EngagementInputs> = {}): EngagementInputs {
  return {
    created_at: daysAgo(30),
    last_responded_at: null,
    last_contacted_at: null,
    total_messages_received: 0,
    total_emails_opened: 0,
    response_time_avg_minutes: null,
    consultation_date: null,
    ...overrides,
  }
}

describe('computeEngagement bands', () => {
  it('replied yesterday ⇒ hot', () => {
    expect(computeEngagement(lead({ last_responded_at: daysAgo(1) }), NOW).temperature).toBe('hot')
  })

  it('replied just inside the warm window ⇒ warm', () => {
    expect(
      computeEngagement(lead({ last_responded_at: daysAgo(HOT_DAYS + 1) }), NOW).temperature,
    ).toBe('warm')
  })

  it('replied a month ago ⇒ cooling', () => {
    expect(
      computeEngagement(lead({ last_responded_at: daysAgo(WARM_DAYS + 10) }), NOW).temperature,
    ).toBe('cooling')
  })

  it('replied beyond the cooling window ⇒ cold', () => {
    expect(
      computeEngagement(lead({ last_responded_at: daysAgo(COOLING_DAYS + 1) }), NOW).temperature,
    ).toBe('cold')
  })

  it('never replied, fresh intake ⇒ new (NOT cold)', () => {
    expect(
      computeEngagement(lead({ created_at: daysAgo(1) }), NOW).temperature,
    ).toBe('new')
  })

  it('never replied, past the grace window ⇒ cold', () => {
    expect(
      computeEngagement(lead({ created_at: daysAgo(NEW_GRACE_DAYS + 1) }), NOW).temperature,
    ).toBe('cold')
  })

  it('upcoming consultation ⇒ hot even if silent on SMS', () => {
    expect(
      computeEngagement(lead({ consultation_date: daysAgo(-2) }), NOW).temperature,
    ).toBe('hot')
  })

  it('a consultation in the past does not force hot', () => {
    expect(
      computeEngagement(lead({ consultation_date: daysAgo(20) }), NOW).temperature,
    ).toBe('cold')
  })
})

describe('computeEngagement score', () => {
  it('is 0 for a total ghost', () => {
    expect(computeEngagement(lead(), NOW).score).toBe(0)
  })

  it('recent reply outscores an old one', () => {
    const fresh = computeEngagement(lead({ last_responded_at: daysAgo(1) }), NOW).score
    const stale = computeEngagement(lead({ last_responded_at: daysAgo(30) }), NOW).score
    expect(fresh).toBeGreaterThan(stale)
  })

  it('depth is capped so dead long threads cannot outrank live short ones', () => {
    const deadNovel = computeEngagement(
      lead({ last_responded_at: daysAgo(60), total_messages_received: 40 }),
      NOW,
    ).score
    const liveShort = computeEngagement(
      lead({ last_responded_at: daysAgo(1), total_messages_received: 2 }),
      NOW,
    ).score
    expect(liveShort).toBeGreaterThan(deadNovel)
  })

  it('never exceeds 100', () => {
    const maxed = computeEngagement(
      lead({
        last_responded_at: daysAgo(0),
        total_messages_received: 50,
        response_time_avg_minutes: 5,
        consultation_date: daysAgo(-1),
        total_emails_opened: 20,
      }),
      NOW,
    )
    expect(maxed.score).toBeLessThanOrEqual(100)
    expect(maxed.temperature).toBe('hot')
  })

  it('tolerates null counters (bulk-imported rows)', () => {
    const r = computeEngagement(
      lead({
        total_messages_received: null,
        total_emails_opened: null,
        response_time_avg_minutes: null,
      }),
      NOW,
    )
    expect(r.score).toBe(0)
    expect(r.temperature).toBe('cold')
  })
})
