import { describe, it, expect } from 'vitest'
import { isAllowlisted, parseAllowlist, allowlistActive } from '@/lib/messaging/test-allowlist'

const LIST = '+14156767420, aminpashas@gmail.com'

describe('test-allowlist', () => {
  it('parses + normalizes to lowercase, trimmed, non-empty', () => {
    expect(parseAllowlist(' A@B.com , +1555 , ')).toEqual(['a@b.com', '+1555'])
    expect(parseAllowlist(undefined)).toEqual([])
  })

  it('allows ALL recipients when the allowlist is empty (gate off)', () => {
    expect(isAllowlisted('anyone@example.com', '')).toBe(true)
    expect(allowlistActive('')).toBe(false)
  })

  it('restricts to listed recipients when the allowlist is set (gate on)', () => {
    expect(allowlistActive(LIST)).toBe(true)
    expect(isAllowlisted('+14156767420', LIST)).toBe(true)
    expect(isAllowlisted('AMINPASHAS@gmail.com', LIST)).toBe(true) // case-insensitive
    expect(isAllowlisted('someone-else@evil.com', LIST)).toBe(false)
    expect(isAllowlisted('+19998887777', LIST)).toBe(false)
  })
})
