import { describe, it, expect } from 'vitest'
import {
  POST_CONSULT_NURTURE_STEPS,
  POST_CONSULT_NURTURE_KEY,
  NURTURE_EXIT_STATUSES,
} from '@/lib/campaigns/post-consult-nurture'

/**
 * Locks the "rules" of the funding nurture so accidental edits to the template
 * can't silently change cadence, gating, or the co-signer/financing behavior.
 */
describe('post-consult funding nurture template', () => {
  const steps = POST_CONSULT_NURTURE_STEPS

  it('has a stable system key and 11 sequential steps', () => {
    expect(POST_CONSULT_NURTURE_KEY).toBe('post_consult_funding_nurture')
    expect(steps).toHaveLength(11)
    steps.forEach((s, i) => expect(s.step_number).toBe(i + 1))
  })

  it('starts on Day 2 (avoids colliding with the day-of thank-you) and tapers to ~75 days', () => {
    // First step delay is measured from enrollment.
    expect(steps[0].delay_minutes).toBe(2 * 1440)
    // Cumulative delay = total campaign length. Should land in the agreed 60–90 day window.
    const totalDays = steps.reduce((sum, s) => sum + s.delay_minutes, 0) / 1440
    expect(totalDays).toBeGreaterThanOrEqual(60)
    expect(totalDays).toBeLessThanOrEqual(90)
  })

  it('is front-loaded early then tapers (widening gaps in the back half)', () => {
    // Steps 1-2 are a tight recap+value pair; from step 3 on, gaps only widen.
    for (let i = 3; i < steps.length; i++) {
      expect(steps[i].delay_minutes).toBeGreaterThanOrEqual(steps[i - 1].delay_minutes)
    }
    // The longest gap is the final graceful-release touch.
    const maxGap = Math.max(...steps.map((s) => s.delay_minutes))
    expect(steps[steps.length - 1].delay_minutes).toBe(maxGap)
  })

  it('routes every AI step through the objection-aware closer with a goal', () => {
    const aiSteps = steps.filter((s) => s.ai_personalize)
    expect(aiSteps.length).toBeGreaterThan(0)
    for (const s of aiSteps) {
      expect(s.metadata.ai_generator).toBe('closer')
      expect(typeof s.metadata.nurture_goal).toBe('string')
      expect((s.metadata.nurture_goal || '').length).toBeGreaterThan(20)
    }
  })

  it('gates the funding-help steps (self-fund, co-signer, alt-financing) on financing not being approved', () => {
    const gated = steps.filter((s) => (s.send_condition as any)?.if_financing_not_approved === true)
    // Steps 4 (self-fund), 6 (co-signer), 7 (alt financing).
    expect(gated.map((s) => s.step_number).sort((a, b) => a - b)).toEqual([4, 6, 7])
  })

  it('recruits a co-signer with a forwardable financing link exactly once', () => {
    const linkSteps = steps.filter((s) => s.metadata.append_financing_link)
    expect(linkSteps).toHaveLength(1)
    expect(linkSteps[0].step_number).toBe(6)
  })

  it('mixes SMS and email channels', () => {
    expect(steps.some((s) => s.channel === 'sms')).toBe(true)
    expect(steps.some((s) => s.channel === 'email')).toBe(true)
  })

  it('exits on close/loss so it never messages a converted or dead lead', () => {
    for (const status of ['contract_signed', 'scheduled', 'in_treatment', 'completed', 'lost', 'disqualified']) {
      expect(NURTURE_EXIT_STATUSES).toContain(status)
    }
  })
})
