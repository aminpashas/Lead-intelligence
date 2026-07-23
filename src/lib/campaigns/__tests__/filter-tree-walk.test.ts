/**
 * Tree walk — recursion + combine + negate, with an injected leaf resolver so
 * the orchestration is verifiable without any I/O. Each leaf resolver here just
 * maps a condition to a canned lead-ID set.
 */

import { describe, expect, it } from 'vitest'
import { walkFilterTree } from '@/lib/campaigns/filter-tree'
import type { FilterCondition, FilterNode } from '@/lib/campaigns/filter-tree'

const S = (...ids: string[]) => new Set(ids)
const sorted = (s: Set<string>) => [...s].sort()

// Canned leaf data keyed by field. state=CA → {a,b,c}; age≥40 → {b,c,d}.
const LEAF: Record<string, Set<string>> = {
  state: S('a', 'b', 'c'),
  age: S('b', 'c', 'd'),
  city: S('c', 'd', 'e'),
}
const resolveLeaf = async (c: FilterCondition) => LEAF[c.field] ?? new Set<string>()
const UNIVERSE = S('a', 'b', 'c', 'd', 'e')

describe('walkFilterTree', () => {
  it('resolves a bare condition to its leaf set', async () => {
    const node: FilterNode = { type: 'condition', field: 'state', operator: 'in', value: ['CA'] }
    expect(sorted(await walkFilterTree(node, { universe: UNIVERSE, resolveLeaf }))).toEqual(['a', 'b', 'c'])
  })

  it('AND group intersects children', async () => {
    const node: FilterNode = {
      type: 'group', op: 'and',
      children: [
        { type: 'condition', field: 'state', operator: 'in', value: ['CA'] },
        { type: 'condition', field: 'age', operator: 'gte', value: 40 },
      ],
    }
    expect(sorted(await walkFilterTree(node, { universe: UNIVERSE, resolveLeaf }))).toEqual(['b', 'c'])
  })

  it('OR group unions children', async () => {
    const node: FilterNode = {
      type: 'group', op: 'or',
      children: [
        { type: 'condition', field: 'state', operator: 'in', value: ['CA'] },
        { type: 'condition', field: 'city', operator: 'in', value: ['SF'] },
      ],
    }
    expect(sorted(await walkFilterTree(node, { universe: UNIVERSE, resolveLeaf }))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('negated group complements against the universe', async () => {
    const node: FilterNode = {
      type: 'group', op: 'and', negate: true,
      children: [{ type: 'condition', field: 'state', operator: 'in', value: ['CA'] }],
    }
    // NOT(state in CA) = universe \ {a,b,c} = {d,e}
    expect(sorted(await walkFilterTree(node, { universe: UNIVERSE, resolveLeaf }))).toEqual(['d', 'e'])
  })

  it('handles nested groups (AND of OR)', async () => {
    const node: FilterNode = {
      type: 'group', op: 'and',
      children: [
        { type: 'condition', field: 'age', operator: 'gte', value: 40 }, // {b,c,d}
        {
          type: 'group', op: 'or',
          children: [
            { type: 'condition', field: 'state', operator: 'in', value: ['CA'] }, // {a,b,c}
            { type: 'condition', field: 'city', operator: 'in', value: ['SF'] },   // {c,d,e}
          ],
        }, // union {a,b,c,d,e}
      ],
    }
    // {b,c,d} ∩ {a,b,c,d,e} = {b,c,d}
    expect(sorted(await walkFilterTree(node, { universe: UNIVERSE, resolveLeaf }))).toEqual(['b', 'c', 'd'])
  })
})
