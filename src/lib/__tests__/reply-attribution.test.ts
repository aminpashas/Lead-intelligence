import { describe, it, expect } from 'vitest'
import { computeReplyStepIncrements } from '@/lib/campaigns/reply-attribution'

const step = (id: string, campaign_id: string, step_number: number, total_replied: number | null = 0) =>
  ({ id, campaign_id, step_number, total_replied })

describe('computeReplyStepIncrements', () => {
  it('credits the current step of an active enrollment', () => {
    const out = computeReplyStepIncrements(
      [{ campaign_id: 'c1', current_step: 2 }],
      [step('s1', 'c1', 1, 4), step('s2', 'c1', 2, 4)]
    )
    expect(out).toEqual([{ id: 's2', total_replied: 5 }])
  })

  it('defaults a null current_step to step 0', () => {
    const out = computeReplyStepIncrements(
      [{ campaign_id: 'c1', current_step: null }],
      [step('s0', 'c1', 0, 0)]
    )
    expect(out).toEqual([{ id: 's0', total_replied: 1 }])
  })

  it('credits one step per campaign when the lead is in several', () => {
    const out = computeReplyStepIncrements(
      [
        { campaign_id: 'c1', current_step: 0 },
        { campaign_id: 'c2', current_step: 1 },
      ],
      [step('s1', 'c1', 0, 2), step('s2', 'c2', 1, 9)]
    )
    expect(out).toEqual([
      { id: 's1', total_replied: 3 },
      { id: 's2', total_replied: 10 },
    ])
  })

  it('never credits the same step twice in one call', () => {
    const out = computeReplyStepIncrements(
      [
        { campaign_id: 'c1', current_step: 0 },
        { campaign_id: 'c1', current_step: 0 },
      ],
      [step('s1', 'c1', 0, 0)]
    )
    expect(out).toEqual([{ id: 's1', total_replied: 1 }])
  })

  it('produces nothing when no step matches the enrollment position', () => {
    const out = computeReplyStepIncrements(
      [{ campaign_id: 'c1', current_step: 5 }],
      [step('s1', 'c1', 0), step('s2', 'c1', 1)]
    )
    expect(out).toEqual([])
  })
})
