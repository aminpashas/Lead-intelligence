import { describe, it, expect } from 'vitest'
import { isUsSmsBlocked, A2P_PENDING_MESSAGE } from '@/lib/messaging/a2p-gate'

describe('isUsSmsBlocked (fail-closed A2P gate)', () => {
  it('blocks when the flag is absent (fail-closed)', () => {
    expect(isUsSmsBlocked({})).toBe(true)
    expect(isUsSmsBlocked(null)).toBe(true)
    expect(isUsSmsBlocked(undefined)).toBe(true)
  })
  it('blocks when the flag is explicitly false', () => {
    expect(isUsSmsBlocked({ us_sms_enabled: false })).toBe(true)
  })
  it('allows only when the flag is explicitly true', () => {
    expect(isUsSmsBlocked({ us_sms_enabled: true })).toBe(false)
  })
  it('exposes a non-empty user-facing message', () => {
    expect(A2P_PENDING_MESSAGE.length).toBeGreaterThan(0)
  })
})
