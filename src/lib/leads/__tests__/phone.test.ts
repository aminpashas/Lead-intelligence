import { describe, it, expect } from 'vitest'
import { formatToE164, formatPhoneForSpeech } from '@/lib/leads/phone'

describe('formatToE164', () => {
  it('prefixes +1 for a bare 10-digit US number', () => {
    expect(formatToE164('4156767420')).toBe('+14156767420')
  })

  it('strips formatting and keeps a leading country code', () => {
    expect(formatToE164('1 (415) 676-7420')).toBe('+14156767420')
  })

  it('rejects too-short / empty input', () => {
    expect(formatToE164('12345')).toBeNull()
    expect(formatToE164('')).toBeNull()
    expect(formatToE164(null)).toBeNull()
  })
})

describe('formatPhoneForSpeech — callback number the voice agent reads aloud', () => {
  it('formats a 10-digit number as (AAA) BBB-CCCC', () => {
    expect(formatPhoneForSpeech('4156767420')).toBe('(415) 676-7420')
  })

  it('drops a US country code before formatting', () => {
    expect(formatPhoneForSpeech('+14156767420')).toBe('(415) 676-7420')
    expect(formatPhoneForSpeech('14156767420')).toBe('(415) 676-7420')
  })

  it('normalizes already-formatted input', () => {
    expect(formatPhoneForSpeech('(415) 676-7420')).toBe('(415) 676-7420')
  })

  it('returns empty string for missing input (never a stray value to read back)', () => {
    expect(formatPhoneForSpeech(null)).toBe('')
    expect(formatPhoneForSpeech(undefined)).toBe('')
    expect(formatPhoneForSpeech('')).toBe('')
  })

  it('falls back to the raw input when it is not a US 10-digit number', () => {
    // A non-parseable value is returned verbatim rather than mangled, so the
    // prompt can still say *something* deliberate instead of guessing.
    expect(formatPhoneForSpeech('+44 20 7946 0958')).toBe('+44 20 7946 0958')
  })
})
