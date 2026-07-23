/**
 * URL param (de)serialization for the advanced filter tree. The tree rides in a
 * single URL-safe param so a leads search stays shareable/bookmarkable like the
 * page's other filters. Decoding is validation-gated — a tampered or stale param
 * must fail closed (null), never throw or inject an unknown field.
 */

import { describe, expect, it } from 'vitest'
import { encodeFilterParam, decodeFilterParam } from '@/lib/leads/filter-param'
import type { FilterNode } from '@/lib/campaigns/filter-tree'

const TREE: FilterNode = {
  type: 'group', op: 'and',
  children: [
    { type: 'condition', field: 'state', operator: 'in', value: ['CA'] },
    { type: 'condition', field: 'age', operator: 'between', value: [30, 65] },
  ],
}

describe('encode/decode filter param', () => {
  it('round-trips a tree', () => {
    const decoded = decodeFilterParam(encodeFilterParam(TREE))
    expect(decoded).toEqual(TREE)
  })

  it('produces a URL-safe string (no +, /, =, or spaces)', () => {
    expect(encodeFilterParam(TREE)).not.toMatch(/[+/=\s]/)
  })

  it('returns null for undefined / empty input', () => {
    expect(decodeFilterParam(undefined)).toBeNull()
    expect(decodeFilterParam('')).toBeNull()
  })

  it('returns null for garbage (fails closed, no throw)', () => {
    expect(decodeFilterParam('not-valid-base64!!')).toBeNull()
    expect(decodeFilterParam(encodeFilterParam(TREE) + 'XYZ%%')).toBeNull()
  })

  it('returns null when the decoded tree references an unknown field', () => {
    // Hand-craft a valid-base64 payload whose field is not in the registry.
    const evil = Buffer.from(JSON.stringify({
      type: 'group', op: 'and',
      children: [{ type: 'condition', field: 'ssn', operator: 'eq', value: '1' }],
    })).toString('base64url')
    expect(decodeFilterParam(evil)).toBeNull()
  })
})
