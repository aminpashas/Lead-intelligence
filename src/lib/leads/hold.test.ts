import { describe, it, expect } from 'vitest'
import { isOnHold } from './hold'

describe('isOnHold', () => {
  const now = new Date('2026-07-20T12:00:00Z')

  it('is false when hold_until is null', () => {
    expect(isOnHold({ hold_until: null }, now)).toBe(false)
  })

  it('is true when hold_until is in the future', () => {
    expect(isOnHold({ hold_until: '2026-07-25T12:00:00Z' }, now)).toBe(true)
  })

  it('is false when hold_until is in the past', () => {
    expect(isOnHold({ hold_until: '2026-07-19T12:00:00Z' }, now)).toBe(false)
  })

  it('is false at exactly now (boundary — hold has just expired)', () => {
    expect(isOnHold({ hold_until: '2026-07-20T12:00:00Z' }, now)).toBe(false)
  })
})
