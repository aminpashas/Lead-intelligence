import { describe, it, expect } from 'vitest'
import { computeChangedFields } from '@/lib/audit/diff'

describe('computeChangedFields', () => {
  it('returns keys whose values differ', () => {
    expect(computeChangedFields({ stage: 'new', name: 'Ada', score: 10 }, { stage: 'won', name: 'Ada', score: 10 })).toEqual(['stage'])
  })
  it('treats added and removed keys as changed', () => {
    expect(computeChangedFields({ a: 1 }, { a: 1, b: 2 })).toEqual(['b'])
    expect(computeChangedFields({ a: 1, b: 2 }, { a: 1 })).toEqual(['b'])
  })
  it('compares nested values structurally, not by reference', () => {
    expect(computeChangedFields({ tags: ['x'] }, { tags: ['x'] })).toEqual([])
  })
  it('handles null before (insert) and null after (delete)', () => {
    expect(computeChangedFields(null, { a: 1 })).toEqual(['a'])
    expect(computeChangedFields({ a: 1 }, null)).toEqual(['a'])
    expect(computeChangedFields(null, null)).toEqual([])
  })
})
