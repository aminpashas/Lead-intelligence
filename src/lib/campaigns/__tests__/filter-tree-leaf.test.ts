/**
 * Leaf predicate mapping — a single filter condition → PostgREST query methods.
 * This is the operator-translation layer; correctness of the SQL each operator
 * emits is pinned here with a recording query stand-in (no I/O).
 */

import { describe, expect, it } from 'vitest'
import { applyLeafPredicate } from '@/lib/campaigns/filter-tree'

/** Records applied filters; every method returns the proxy so chaining works. */
function fakeQuery() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const q = new Proxy(
    {},
    {
      get: (_t, method: string) => {
        if (method === 'calls') return calls
        return (...args: unknown[]) => {
          calls.push({ method, args })
          return q
        }
      },
    }
  ) as { calls: Array<{ method: string; args: unknown[] }> } & Record<string, (...a: unknown[]) => unknown>
  return q
}

const apply = (field: string, operator: string, value?: unknown) => {
  const q = fakeQuery()
  applyLeafPredicate(q, { type: 'condition', field, operator: operator as never, value })
  return q.calls
}

describe('applyLeafPredicate — column operators', () => {
  it('in → .in(column, value)', () => {
    expect(apply('status', 'in', ['new', 'contacted'])).toContainEqual({
      method: 'in', args: ['status', ['new', 'contacted']],
    })
  })

  it('not_in → .not(column, "in", "(a,b)")', () => {
    expect(apply('status', 'not_in', ['lost', 'disqualified'])).toContainEqual({
      method: 'not', args: ['status', 'in', '(lost,disqualified)'],
    })
  })

  it('between → gte(min) AND lte(max)', () => {
    const calls = apply('age', 'between', [30, 65])
    expect(calls).toContainEqual({ method: 'gte', args: ['age', 30] })
    expect(calls).toContainEqual({ method: 'lte', args: ['age', 65] })
  })

  it('after → gte, before → lte on the date column', () => {
    expect(apply('created_at', 'after', '2026-01-01')).toContainEqual({
      method: 'gte', args: ['created_at', '2026-01-01'],
    })
    expect(apply('created_at', 'before', '2026-02-01')).toContainEqual({
      method: 'lte', args: ['created_at', '2026-02-01'],
    })
  })

  it('contains → ilike with wildcards', () => {
    expect(apply('city', 'contains', 'francisco')).toContainEqual({
      method: 'ilike', args: ['city', '%francisco%'],
    })
  })

  it('is_null → .is(column, null); not_null → .not(column, "is", null)', () => {
    expect(apply('last_responded_at', 'is_null')).toContainEqual({ method: 'is', args: ['last_responded_at', null] })
    expect(apply('last_responded_at', 'not_null')).toContainEqual({ method: 'not', args: ['last_responded_at', 'is', null] })
  })
})

describe('applyLeafPredicate — service_line (special, derived)', () => {
  it('applies an .or() group from serviceLineOrFilter, not a column predicate', () => {
    const calls = apply('service_line', 'eq', 'tmj')
    const orCall = calls.find((c) => c.method === 'or')
    expect(orCall).toBeTruthy()
    // The tmj service-line filter selects the tmj tag among its signals.
    expect(String(orCall!.args[0])).toContain('tmj')
    // It must NOT try to filter a literal `service_line` column (there is none).
    expect(calls.find((c) => c.args[0] === 'service_line')).toBeUndefined()
  })
})
