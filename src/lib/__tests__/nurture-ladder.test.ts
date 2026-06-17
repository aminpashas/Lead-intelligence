import { describe, it, expect } from 'vitest'
import {
  reengagementStage,
  reengagementStep,
  buildReengagementMessage,
  REENGAGEMENT_MIN_IDLE_DAYS,
} from '@/lib/nurture/ladder'

describe('reengagementStage', () => {
  it('not due before the min idle window', () => {
    expect(reengagementStage(0)).toBeNull()
    expect(reengagementStage(REENGAGEMENT_MIN_IDLE_DAYS - 1)).toBeNull()
  })

  it('maps silence duration to the right stage', () => {
    expect(reengagementStage(7)).toBe('value_add_touch')
    expect(reengagementStage(13)).toBe('value_add_touch')
    expect(reengagementStage(14)).toBe('testimonial_nudge')
    expect(reengagementStage(21)).toBe('deadline_anchor')
    expect(reengagementStage(30)).toBe('direct_ask')
    expect(reengagementStage(45)).toBe('final_stand')
    expect(reengagementStage(60)).toBe('graceful_release')
    expect(reengagementStage(120)).toBe('graceful_release')
  })
})

describe('reengagementStep', () => {
  it('only graceful_release is terminal', () => {
    expect(reengagementStep(7)!.terminal).toBe(false)
    expect(reengagementStep(45)!.terminal).toBe(false)
    expect(reengagementStep(60)!.terminal).toBe(true)
  })

  it('carries a positive next delay for non-terminal stages', () => {
    expect(reengagementStep(7)!.nextDelayDays).toBeGreaterThan(0)
    expect(reengagementStep(30)!.nextDelayDays).toBeGreaterThan(0)
  })

  it('returns null when not due', () => {
    expect(reengagementStep(3)).toBeNull()
  })
})

describe('buildReengagementMessage', () => {
  it('personalizes with name + org and stays non-empty for every stage', () => {
    const stages = [
      'value_add_touch',
      'testimonial_nudge',
      'deadline_anchor',
      'direct_ask',
      'final_stand',
      'graceful_release',
    ] as const
    for (const stage of stages) {
      const msg = buildReengagementMessage(stage, { firstName: 'Sam', orgName: 'Dion Health' })
      expect(msg.length).toBeGreaterThan(10)
      expect(msg).toContain('Sam')
    }
  })

  it('falls back gracefully without name/org', () => {
    const msg = buildReengagementMessage('graceful_release', {})
    expect(msg).toContain('there')
    expect(msg).toContain('our team')
  })
})
