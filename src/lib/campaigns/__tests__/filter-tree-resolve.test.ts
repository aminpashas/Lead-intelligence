/**
 * Integration test for the DB-backed resolver path (resolveLeaf → resolveFilterTree)
 * using a fake Supabase client that records the chained query and returns canned
 * rows. Covers what the pure unit tests can't: which TABLE each leaf queries
 * (leads vs messages), lead_id de-dup for conversation-activity, AND/OR
 * combination end-to-end, and the universe fetch that a negated group triggers.
 */

import { describe, expect, it } from 'vitest'
import { resolveFilterTree } from '@/lib/campaigns/filter-tree'
import type { FilterNode } from '@/lib/campaigns/filter-tree'

type Call = { m: string; args: unknown[] }

/** Fake Supabase whose builder is thenable; `dataFor(table, calls)` decides rows. */
function fakeSupabase(dataFor: (table: string, calls: Call[]) => unknown[]) {
  const log: { table: string; calls: Call[] }[] = []
  const from = (table: string) => {
    const calls: Call[] = []
    log.push({ table, calls })
    const b: Record<string, (...a: unknown[]) => unknown> = {}
    for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'or', 'not', 'is', 'ilike', 'neq', 'order', 'range']) {
      b[m] = (...args: unknown[]) => { calls.push({ m, args }); return b }
    }
    b.limit = (...args: unknown[]) => { calls.push({ m: 'limit', args }); return b }
    ;(b as { then?: unknown }).then = (resolve: (v: unknown) => void) => {
      const data = dataFor(table, calls)
      resolve({ data, count: data.length })
    }
    return b
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from } as any, log }
}

/** A leads query carries a real predicate (beyond the org eq) → not the universe fetch. */
const hasLeafPredicate = (calls: Call[]) =>
  calls.some((c) => ['in', 'gte', 'lte', 'or', 'not', 'ilike', 'neq'].includes(c.m))

describe('resolveFilterTree — DB-backed resolution', () => {
  it('resolves a column leaf against the leads table', async () => {
    const { client, log } = fakeSupabase((table) => (table === 'leads' ? [{ id: 'a' }, { id: 'b' }] : []))
    const tree: FilterNode = { type: 'condition', field: 'city', operator: 'in', value: ['SF'] }
    const set = await resolveFilterTree(client, 'org', tree)
    expect([...set].sort()).toEqual(['a', 'b'])
    expect(log[0].table).toBe('leads')
    expect(log[0].calls).toContainEqual({ m: 'in', args: ['city', ['SF']] })
  })

  it('resolves conversation_activity against the messages table and de-dups lead_id', async () => {
    const { client, log } = fakeSupabase((table) =>
      table === 'messages' ? [{ lead_id: 'x' }, { lead_id: 'y' }, { lead_id: 'x' }, { lead_id: null }] : []
    )
    const tree: FilterNode = {
      type: 'condition', field: 'conversation_activity', operator: 'between', value: ['2026-01-01', '2026-02-01'],
    }
    const set = await resolveFilterTree(client, 'org', tree)
    expect([...set].sort()).toEqual(['x', 'y']) // deduped, null dropped
    expect(log[0].table).toBe('messages')
    expect(log[0].calls).toContainEqual({ m: 'gte', args: ['created_at', '2026-01-01'] })
    expect(log[0].calls).toContainEqual({ m: 'lte', args: ['created_at', '2026-02-01'] })
  })

  it('AND-intersects a leads leaf with a messages leaf', async () => {
    const { client } = fakeSupabase((table) =>
      table === 'messages' ? [{ lead_id: 'b' }, { lead_id: 'c' }] : [{ id: 'a' }, { id: 'b' }]
    )
    const tree: FilterNode = {
      type: 'group', op: 'and',
      children: [
        { type: 'condition', field: 'city', operator: 'in', value: ['SF'] },        // {a,b}
        { type: 'condition', field: 'conversation_activity', operator: 'after', value: '2026-01-01' }, // {b,c}
      ],
    }
    const set = await resolveFilterTree(client, 'org', tree)
    expect([...set]).toEqual(['b'])
  })

  it('a negated group fetches the universe and complements against it', async () => {
    const { client } = fakeSupabase((table, calls) => {
      if (table !== 'leads') return []
      // The city leaf query carries an .in() predicate; the universe fetch does not.
      return hasLeafPredicate(calls) ? [{ id: 'a' }] : [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    })
    const tree: FilterNode = {
      type: 'group', op: 'and', negate: true,
      children: [{ type: 'condition', field: 'city', operator: 'in', value: ['SF'] }],
    }
    // NOT(city in SF) = universe {a,b,c} \ {a} = {b,c}
    const set = await resolveFilterTree(client, 'org', tree)
    expect([...set].sort()).toEqual(['b', 'c'])
  })
})
