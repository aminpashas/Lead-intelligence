import { describe, it, expect } from 'vitest'
import { normalizeSheetStatus, parseSheetDate, rowCloseProbability, TEMP_PROBABILITY } from '@/lib/pipeline/closing-book'

describe('normalizeSheetStatus', () => {
  it('maps recognized gut-feel keywords to temperature + probability', () => {
    expect(normalizeSheetStatus('maybe')).toMatchObject({ temperature: 'warm', won: false })
    expect(normalizeSheetStatus('cold')).toMatchObject({ temperature: 'cold', won: false })
    expect(normalizeSheetStatus('Super cold')).toMatchObject({ temperature: 'cold' })
    // super cold is less likely than plain cold
    expect(normalizeSheetStatus('Super cold').closeProbability)
      .toBeLessThan(normalizeSheetStatus('cold').closeProbability)
  })

  it('treats a decline as stalled with near-zero probability', () => {
    const n = normalizeSheetStatus('NO')
    expect(n.temperature).toBe('stalled')
    expect(n.closeProbability).toBeLessThan(0.05)
  })

  it('flags closed deals as won at probability 1', () => {
    expect(normalizeSheetStatus('CLOSED ')).toMatchObject({ won: true, closeProbability: 1, temperature: 'hot' })
  })

  it('parks unrecognized text as a note and leaves temperature to derive', () => {
    const n = normalizeSheetStatus('out of the country')
    expect(n.temperature).toBeNull()
    expect(n.note).toBe('out of the country')
  })

  it('empty cell → no override, no note', () => {
    expect(normalizeSheetStatus('')).toEqual({ temperature: null, closeProbability: TEMP_PROBABILITY.cold, won: false, note: null })
    expect(normalizeSheetStatus(null)).toMatchObject({ temperature: null, note: null })
  })
})

describe('parseSheetDate', () => {
  it('converts an Excel serial to an ISO date', () => {
    // 46199 in the 1900 date system is 2026-06-26.
    expect(parseSheetDate('46199.0')).toBe('2026-06-26')
    expect(parseSheetDate('46211')).toBe('2026-07-08')
  })

  it('parses a hand-typed M/D/YY, tolerating a stray slash', () => {
    expect(parseSheetDate('6/26//26')).toBe('2026-06-26')
    expect(parseSheetDate('7/8/26')).toBe('2026-07-08')
  })

  it('returns null for blank or unparseable values', () => {
    expect(parseSheetDate('')).toBeNull()
    expect(parseSheetDate(null)).toBeNull()
    expect(parseSheetDate('sometime soon')).toBeNull()
  })
})

describe('rowCloseProbability', () => {
  it('uses the seeded value when present', () => {
    expect(rowCloseProbability(0.72, 'cold')).toBe(0.72)
  })
  it('falls back to the temperature default when unseeded', () => {
    expect(rowCloseProbability(null, 'warm')).toBe(TEMP_PROBABILITY.warm)
    expect(rowCloseProbability(undefined, 'hot')).toBe(TEMP_PROBABILITY.hot)
  })
})
