import { describe, it, expect } from 'vitest'
import { evaluateCandidate, recoverLeadName } from '../recover-name'

/**
 * The rejections matter more than the acceptances here. This module exists to
 * put names BACK onto ~4,600 leads whose names were nulled by
 * `scrub-phone-names`, and the sources it reads (GHL/CareStack `name` fields)
 * are exactly where the phone numbers came from in the first place. A regression
 * that lets one through re-creates the original defect — "Hi (925)," in a text
 * to a patient — at scale and silently.
 */
describe('evaluateCandidate', () => {
  it('accepts a normal first/last pair', () => {
    expect(evaluateCandidate({ source: 'carestack', first: 'Jane', last: 'Doe' })).toEqual({
      first: 'Jane',
      last: 'Doe',
      source: 'carestack',
    })
  })

  it('splits a combined full name when first/last are absent', () => {
    expect(evaluateCandidate({ source: 'ghl', full: 'Jane Q Public' })).toEqual({
      first: 'Jane',
      last: 'Q Public',
      source: 'ghl',
    })
  })

  it('accepts a first name with no surname', () => {
    expect(evaluateCandidate({ source: 'ghl', first: 'Jane' })).toEqual({
      first: 'Jane',
      last: null,
      source: 'ghl',
    })
  })

  // ── the rejections ──────────────────────────────────────────────────

  it('rejects a phone number split across both columns', () => {
    expect(evaluateCandidate({ source: 'ghl', first: '(925)', last: '497-0821' })).toBeNull()
  })

  it('rejects a phone number arriving as one combined string', () => {
    expect(evaluateCandidate({ source: 'ghl', full: '(925) 497-0821' })).toBeNull()
    expect(evaluateCandidate({ source: 'ghl', full: '+52 675 108 4917' })).toBeNull()
  })

  it('keeps the real name when only one column is a stray phone number', () => {
    expect(evaluateCandidate({ source: 'ghl', first: '5103315182', last: 'boyer' })).toEqual({
      first: null,
      last: 'boyer',
      source: 'ghl',
    })
  })

  it('rejects carrier placeholders', () => {
    expect(evaluateCandidate({ source: 'ghl', full: 'Wireless Caller' })).toBeNull()
    expect(evaluateCandidate({ source: 'ghl', first: 'Unknown' })).toBeNull()
    expect(evaluateCandidate({ source: 'ghl', full: 'SCAM LIKELY' })).toBeNull()
  })

  it('rejects an email address typed into the name box', () => {
    expect(evaluateCandidate({ source: 'ghl', full: 'jane@example.com' })).toBeNull()
  })

  it('rejects an empty candidate', () => {
    expect(evaluateCandidate({ source: 'ghl' })).toBeNull()
    expect(evaluateCandidate({ source: 'ghl', first: '   ', last: null })).toBeNull()
  })

  // Guards the digit floor inherited from `scrubPhoneNames` — these are real
  // prod names that a blanket "looks numeric" rule would have destroyed.
  it('keeps real names that merely contain a number', () => {
    expect(evaluateCandidate({ source: 'ghl', first: 'Booth', last: '14' })?.last).toBe('14')
    expect(evaluateCandidate({ source: 'ghl', first: 'Elias', last: '111' })?.last).toBe('111')
  })
})

describe('recoverLeadName', () => {
  it('returns the first candidate that yields a real name', () => {
    const result = recoverLeadName([
      { source: 'carestack', first: '(925)', last: '497-0821' },
      { source: 'ghl', first: 'Jane', last: 'Doe' },
    ])
    expect(result).toEqual({ first: 'Jane', last: 'Doe', source: 'ghl' })
  })

  it('prefers the earlier source when both are usable', () => {
    const result = recoverLeadName([
      { source: 'carestack', first: 'Jane', last: 'Doe' },
      { source: 'ghl', first: 'J', last: 'D' },
    ])
    expect(result?.source).toBe('carestack')
  })

  it('returns null when nothing is recoverable', () => {
    expect(
      recoverLeadName([
        { source: 'carestack', full: 'Unknown' },
        { source: 'ghl', full: '(925) 497-0821' },
      ])
    ).toBeNull()
  })

  it('returns null for no candidates at all', () => {
    expect(recoverLeadName([])).toBeNull()
  })
})
