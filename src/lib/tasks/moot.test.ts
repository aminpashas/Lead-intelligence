import { describe, it, expect } from 'vitest'
import { isPossiblyMoot } from '@/lib/tasks/moot'

const CREATED = '2026-07-10T12:00:00.000Z'

describe('isPossiblyMoot', () => {
  it('is true when the lead was contacted after the task was created and never reviewed', () => {
    expect(
      isPossiblyMoot(
        { created_at: CREATED, reviewed_at: null },
        '2026-07-12T09:00:00.000Z'
      )
    ).toBe(true)
  })

  it('is false when the lead was last contacted before the task was created', () => {
    expect(
      isPossiblyMoot(
        { created_at: CREATED, reviewed_at: null },
        '2026-07-09T09:00:00.000Z'
      )
    ).toBe(false)
  })

  it('is false when reviewed after the last contact', () => {
    expect(
      isPossiblyMoot(
        { created_at: CREATED, reviewed_at: '2026-07-12T10:00:00.000Z' },
        '2026-07-12T09:00:00.000Z'
      )
    ).toBe(false)
  })

  it('is true when reviewed, but the lead was contacted again after that review', () => {
    expect(
      isPossiblyMoot(
        { created_at: CREATED, reviewed_at: '2026-07-11T10:00:00.000Z' },
        '2026-07-12T09:00:00.000Z'
      )
    ).toBe(true)
  })

  it('is false when the lead has never been contacted', () => {
    expect(isPossiblyMoot({ created_at: CREATED, reviewed_at: null }, null)).toBe(false)
  })
})
