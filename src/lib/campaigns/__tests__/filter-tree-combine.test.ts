/**
 * Boolean set-combination — the pure core of the filter-tree resolver.
 *
 * Each leaf condition resolves (elsewhere, with I/O) to a Set of matching lead
 * IDs. A group combines its children's sets: `and` intersects, `or` unions, and
 * an optional `negate` takes the complement against the org's candidate universe
 * (the set of all lead IDs the org could match). This function holds that logic
 * and nothing else — no I/O — so the semantics are nailed down here.
 */

import { describe, expect, it } from 'vitest'
import { combineSets } from '@/lib/campaigns/filter-tree'

const S = (...ids: string[]) => new Set(ids)
const sorted = (s: Set<string>) => [...s].sort()

const UNIVERSE = S('a', 'b', 'c', 'd', 'e')

describe('combineSets', () => {
  it('and → intersection of child sets', () => {
    const out = combineSets('and', [S('a', 'b', 'c'), S('b', 'c', 'd')], { universe: UNIVERSE })
    expect(sorted(out)).toEqual(['b', 'c'])
  })

  it('or → union of child sets', () => {
    const out = combineSets('or', [S('a', 'b'), S('b', 'c')], { universe: UNIVERSE })
    expect(sorted(out)).toEqual(['a', 'b', 'c'])
  })

  it('a single child passes through unchanged', () => {
    expect(sorted(combineSets('and', [S('a', 'c')], { universe: UNIVERSE }))).toEqual(['a', 'c'])
    expect(sorted(combineSets('or', [S('a', 'c')], { universe: UNIVERSE }))).toEqual(['a', 'c'])
  })

  it('negate → complement against the universe (or case)', () => {
    // union = {a,b,c}; complement within {a,b,c,d,e} = {d,e}
    const out = combineSets('or', [S('a', 'b'), S('b', 'c')], { negate: true, universe: UNIVERSE })
    expect(sorted(out)).toEqual(['d', 'e'])
  })

  it('negate → complement against the universe (and case)', () => {
    // intersection = {b,c}; complement = {a,d,e}
    const out = combineSets('and', [S('a', 'b', 'c'), S('b', 'c', 'd')], { negate: true, universe: UNIVERSE })
    expect(sorted(out)).toEqual(['a', 'd', 'e'])
  })

  it('and of no children matches the whole universe (identity for AND)', () => {
    // Vacuous AND is "true for everything" — defensive; schema requires ≥1 child.
    expect(sorted(combineSets('and', [], { universe: UNIVERSE }))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('or of no children matches nothing (identity for OR)', () => {
    expect(sorted(combineSets('or', [], { universe: UNIVERSE }))).toEqual([])
  })
})
