/**
 * pruneFilterTree — drop incomplete conditions (empty value) and empty groups
 * so a half-built builder tree never produces an invalid `criteria.filter`.
 */

import { describe, expect, it } from 'vitest'
import { pruneFilterTree } from '@/lib/campaigns/filter-tree'
import type { FilterNode } from '@/lib/campaigns/filter-tree'

describe('pruneFilterTree', () => {
  it('drops a condition with an empty in-list', () => {
    const tree: FilterNode = {
      type: 'group', op: 'and',
      children: [
        { type: 'condition', field: 'status', operator: 'in', value: [] },
        { type: 'condition', field: 'age', operator: 'gte', value: 40 },
      ],
    }
    const out = pruneFilterTree(tree)
    expect(out).toEqual({
      type: 'group', op: 'and',
      children: [{ type: 'condition', field: 'age', operator: 'gte', value: 40 }],
    })
  })

  it('keeps is_null / not_null conditions (they need no value)', () => {
    const tree: FilterNode = {
      type: 'group', op: 'and',
      children: [{ type: 'condition', field: 'last_responded_at', operator: 'is_null' }],
    }
    expect(pruneFilterTree(tree)).toEqual(tree)
  })

  it('drops an empty between and an empty-string scalar', () => {
    const tree: FilterNode = {
      type: 'group', op: 'or',
      children: [
        { type: 'condition', field: 'age', operator: 'between', value: ['', ''] },
        { type: 'condition', field: 'city', operator: 'contains', value: '' },
        { type: 'condition', field: 'city', operator: 'contains', value: 'francisco' },
      ],
    }
    expect(pruneFilterTree(tree)).toEqual({
      type: 'group', op: 'or',
      children: [{ type: 'condition', field: 'city', operator: 'contains', value: 'francisco' }],
    })
  })

  it('removes a group left empty after pruning, and returns null if nothing remains', () => {
    const tree: FilterNode = {
      type: 'group', op: 'and',
      children: [
        { type: 'group', op: 'or', children: [{ type: 'condition', field: 'status', operator: 'in', value: [] }] },
      ],
    }
    expect(pruneFilterTree(tree)).toBeNull()
  })
})
