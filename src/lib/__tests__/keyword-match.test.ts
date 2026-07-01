import { describe, it, expect } from 'vitest'
import { combineTermMatches, sanitizeTerm } from '@/lib/campaigns/keyword-match'

describe('sanitizeTerm', () => {
  it('strips PostgREST-breaking characters and trims', () => {
    expect(sanitizeTerm('  fin,ancing%  ')).toBe('financing')
    expect(sanitizeTerm('a(b)c*')).toBe('abc')
  })
  it('returns empty string for whitespace-only', () => {
    expect(sanitizeTerm('   ')).toBe('')
  })
})

describe('combineTermMatches', () => {
  const a = new Set(['l1', 'l2', 'l3'])
  const b = new Set(['l2', 'l3', 'l4'])
  it('any = union across terms', () => {
    expect([...combineTermMatches([a, b], 'any')].sort()).toEqual(['l1', 'l2', 'l3', 'l4'])
  })
  it('all = intersection across terms', () => {
    expect([...combineTermMatches([a, b], 'all')].sort()).toEqual(['l2', 'l3'])
  })
  it('single term returns that set', () => {
    expect([...combineTermMatches([a], 'all')].sort()).toEqual(['l1', 'l2', 'l3'])
  })
  it('empty input returns empty set', () => {
    expect(combineTermMatches([], 'any').size).toBe(0)
    expect(combineTermMatches([], 'all').size).toBe(0)
  })
})
