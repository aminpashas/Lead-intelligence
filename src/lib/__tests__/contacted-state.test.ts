import { describe, it, expect } from 'vitest'
import {
  classifyContactedState,
  cadenceTimeline,
  ENGAGED_MAX_CADENCE_DAYS,
} from '@/lib/pipeline/contacted-state'

const now = Date.parse('2026-07-07T00:00:00Z')

describe('classifyContactedState', () => {
  it('is engaged when the lead has replied after our last outreach', () => {
    expect(
      classifyContactedState({
        last_contacted_at: '2026-07-05T00:00:00Z',
        last_responded_at: '2026-07-06T00:00:00Z',
        total_messages_received: 0,
      }, now)
    ).toBe('engaged')
  })

  it('is engaged when any inbound message exists even without a response timestamp', () => {
    expect(
      classifyContactedState({
        last_contacted_at: '2026-07-05T00:00:00Z',
        last_responded_at: null,
        total_messages_received: 2,
      }, now)
    ).toBe('engaged')
  })

  it('is following-up when recently contacted and no reply', () => {
    expect(
      classifyContactedState({
        last_contacted_at: '2026-07-04T00:00:00Z',
        last_responded_at: null,
        total_messages_received: 0,
      }, now)
    ).toBe('following-up')
  })

  it('is nurturing when silent past the cadence window', () => {
    expect(
      classifyContactedState({
        last_contacted_at: '2026-06-01T00:00:00Z',
        last_responded_at: null,
        total_messages_received: 0,
      }, now)
    ).toBe('nurturing')
  })

  it('is following-up when never contacted (awaiting first touch)', () => {
    expect(
      classifyContactedState({
        last_contacted_at: null,
        last_responded_at: null,
        total_messages_received: 0,
      }, now)
    ).toBe('following-up')
  })

  it('is engaged when never contacted but a reply timestamp exists', () => {
    expect(
      classifyContactedState({
        last_contacted_at: null,
        last_responded_at: '2026-07-06T00:00:00Z',
        total_messages_received: 0,
      }, now)
    ).toBe('engaged')
  })

  it('is engaged at the boundary when the reply equals our last outreach', () => {
    expect(
      classifyContactedState({
        last_contacted_at: '2026-07-05T00:00:00Z',
        last_responded_at: '2026-07-05T00:00:00Z',
        total_messages_received: 0,
      }, now)
    ).toBe('engaged')
  })
})

describe('cadenceTimeline', () => {
  it('reports Day-N and next-touch for an active enrollment', () => {
    const tl = cadenceTimeline({
      enrollment: { status: 'active', current_step: 3, enrolled_at: '2026-07-01T00:00:00Z' },
      now,
    })
    expect(tl!.dayN).toBe(6)
    expect(tl!.stepIndex).toBe(3)
    expect(tl!.totalSteps).toBe(8)
    expect(tl!.nextTouchAtMs).toBe(Date.parse('2026-07-05T00:00:00Z'))
    expect(tl!.exhausted).toBe(false)
  })

  it('flags exhausted when the enrollment completed', () => {
    const tl = cadenceTimeline({
      enrollment: { status: 'completed', current_step: 8, enrolled_at: '2026-06-20T00:00:00Z' },
      now,
    })
    expect(tl!.exhausted).toBe(true)
    expect(tl!.nextTouchAtMs).toBeNull()
  })

  it('flags exhausted when the enrollment is stopped mid-cadence', () => {
    const tl = cadenceTimeline({
      enrollment: { status: 'stopped', current_step: 2, enrolled_at: '2026-07-01T00:00:00Z' },
      now,
    })
    expect(tl!.exhausted).toBe(true)
    expect(tl!.nextTouchAtMs).toBeNull()
  })

  it('floors a fractional day when computing dayN', () => {
    const tl = cadenceTimeline({
      enrollment: { status: 'active', current_step: 1, enrolled_at: '2026-07-05T12:00:00Z' },
      now,
    })
    expect(tl!.dayN).toBe(1)
  })

  it('returns null timeline when there is no enrollment', () => {
    expect(cadenceTimeline({ enrollment: null, now })).toBeNull()
  })

  it('exports the 14-day boundary constant', () => {
    expect(ENGAGED_MAX_CADENCE_DAYS).toBe(14)
  })
})
