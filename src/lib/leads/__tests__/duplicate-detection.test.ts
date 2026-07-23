import { describe, it, expect } from 'vitest'
import {
  matchingSignals,
  classifyConfidence,
  scoreDuplicatePair,
  type ScorableLead,
} from '../duplicate-detection'

/**
 * The false-positive cases matter most here. This module surfaces pairs to a
 * human who may merge them — collapsing two people's texts, appointments and
 * consent onto one record. A regression that promotes a name-only collision to
 * 'high' is exactly the failure that would let staff merge two different people
 * who happen to share a name (real in this org: "gabriel banon", two numbers).
 */

const lead = (over: Partial<ScorableLead>): ScorableLead => ({
  id: over.id ?? 'x',
  first_name: 'Gabriel',
  last_name: 'Banon',
  email_hash: null,
  phone_hash: null,
  status: 'new',
  source_type: 'direct',
  identityValues: [],
  ...over,
})

describe('matchingSignals', () => {
  it('reports every shared signal', () => {
    const a = lead({ id: 'a', phone_hash: 'P', email_hash: 'E', identityValues: ['psid1'] })
    const b = lead({ id: 'b', phone_hash: 'P', email_hash: 'E', identityValues: ['psid1'] })
    expect(matchingSignals(a, b)).toEqual(['phone', 'email', 'identity', 'name'])
  })

  it('does not treat two null hashes as a match', () => {
    const a = lead({ id: 'a', first_name: 'Ann', last_name: 'Lee', phone_hash: null })
    const b = lead({ id: 'b', first_name: 'Bob', last_name: 'Fox', phone_hash: null })
    expect(matchingSignals(a, b)).toEqual([])
  })

  it('matches names case/punctuation-insensitively', () => {
    const a = lead({ id: 'a', first_name: 'José', last_name: "O'Neil" })
    const b = lead({ id: 'b', first_name: 'jose', last_name: 'oneil' })
    expect(matchingSignals(a, b)).toContain('name')
  })
})

describe('classifyConfidence (DEFAULT POLICY)', () => {
  it('treats a shared email as high on its own', () => {
    expect(classifyConfidence(['email'])).toBe('high')
  })

  it('treats a shared identity as high on its own', () => {
    expect(classifyConfidence(['identity'])).toBe('high')
  })

  it('treats phone alone as only medium (households share a line)', () => {
    expect(classifyConfidence(['phone'])).toBe('medium')
  })

  it('promotes phone+name to high', () => {
    expect(classifyConfidence(['phone', 'name'])).toBe('high')
  })

  it('leaves name-only as low', () => {
    expect(classifyConfidence(['name'])).toBe('low')
  })

  it('lifts name-only to medium when the source_type also matches', () => {
    expect(classifyConfidence(['name'], { sameSourceType: true })).toBe('medium')
  })
})

describe('scoreDuplicatePair', () => {
  it('returns null for the same lead', () => {
    const a = lead({ id: 'a' })
    expect(scoreDuplicatePair(a, a)).toBeNull()
  })

  it('returns null when nothing is comparable', () => {
    const a = lead({ id: 'a', first_name: 'Ann', last_name: 'Lee' })
    const b = lead({ id: 'b', first_name: 'Bob', last_name: 'Fox' })
    expect(scoreDuplicatePair(a, b)).toBeNull()
  })

  it('scores an email match as high confidence', () => {
    const a = lead({ id: 'a', first_name: 'Ann', last_name: 'Lee', email_hash: 'E' })
    const b = lead({ id: 'b', first_name: 'Different', last_name: 'Name', email_hash: 'E' })
    const pair = scoreDuplicatePair(a, b)!
    expect(pair.confidence).toBe('high')
    expect(pair.signals).toEqual(['email'])
    expect(pair.score).toBeGreaterThanOrEqual(90)
  })

  it('scores the two-different-people-same-name case as low, never mergeable-high', () => {
    // The real gabriel-banon rows: same name, DIFFERENT phones, same source.
    const a = lead({ id: 'a', phone_hash: 'P1' })
    const b = lead({ id: 'b', phone_hash: 'P2' })
    const pair = scoreDuplicatePair(a, b)!
    expect(pair.signals).toEqual(['name'])
    // Same source_type ('direct') → medium at most, never high.
    expect(pair.confidence).not.toBe('high')
  })

  it('adds a corroboration bonus when name backs up a contact match', () => {
    const nameless = scoreDuplicatePair(
      lead({ id: 'a', first_name: 'Ann', last_name: 'Lee', phone_hash: 'P' }),
      lead({ id: 'b', first_name: 'Zed', last_name: 'Xu', phone_hash: 'P' }),
    )!
    const withName = scoreDuplicatePair(
      lead({ id: 'a', phone_hash: 'P' }),
      lead({ id: 'b', phone_hash: 'P' }),
    )!
    expect(withName.score).toBeGreaterThan(nameless.score)
  })
})
