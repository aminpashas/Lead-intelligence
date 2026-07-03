import { describe, it, expect } from 'vitest'
import { smartListCriteriaSchema } from '@/lib/validators/smart-list'

describe('smartListCriteriaSchema keywords clause', () => {
  it('accepts a valid keywords clause', () => {
    const r = smartListCriteriaSchema.safeParse({
      keywords: { terms: ['financing'], match: 'any', scopes: ['conversation', 'lead_fields'] },
    })
    expect(r.success).toBe(true)
  })
  it('rejects empty terms', () => {
    expect(smartListCriteriaSchema.safeParse({ keywords: { terms: [], match: 'any', scopes: ['tags'] } }).success).toBe(false)
  })
  it('rejects an unknown scope', () => {
    expect(smartListCriteriaSchema.safeParse({ keywords: { terms: ['x'], match: 'any', scopes: ['bogus'] } }).success).toBe(false)
  })
  it('still accepts existing criteria without keywords', () => {
    expect(smartListCriteriaSchema.safeParse({ statuses: ['new'] }).success).toBe(true)
  })
})
