import { describe, it, expect } from 'vitest'
import { isActiveContactStage } from '@/lib/pipeline/stage-groups'

describe('isActiveContactStage', () => {
  it('is true for the two working-funnel stages', () => {
    expect(isActiveContactStage('contacted')).toBe(true)
    expect(isActiveContactStage('engaged')).toBe(true)
  })
  it('is false for other stages and nullish input', () => {
    expect(isActiveContactStage('qualified')).toBe(false)
    expect(isActiveContactStage('nurturing')).toBe(false)
    expect(isActiveContactStage(null)).toBe(false)
    expect(isActiveContactStage(undefined)).toBe(false)
  })
})
