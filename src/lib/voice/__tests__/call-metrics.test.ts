import { describe, it, expect } from 'vitest'
import { applyCallMetric, ACTIVE_CALL_STATUSES, ACTIVE_CALL_MAX_AGE_MINUTES } from '../call-metrics'

/**
 * A stand-in for the Supabase PostgREST builder that just records every filter
 * chained onto it, so we can assert exactly which predicates a metric adds.
 */
type Filter = { op: string; column: string; value: unknown }
function fakeQuery() {
  const filters: Filter[] = []
  const record = (op: string) => (column: string, value: unknown) => {
    filters.push({ op, column, value })
    return builder
  }
  const builder = {
    filters,
    eq: record('eq'),
    gt: record('gt'),
    gte: record('gte'),
    in: record('in'),
    is: record('is'),
  }
  return builder
}

const TODAY = '2026-07-12T00:00:00.000Z'

describe('applyCallMetric — active ("Live Now")', () => {
  it('requires an active status, an open row, and recency', () => {
    const q = fakeQuery()
    applyCallMetric(q, 'active', TODAY)

    const ops = q.filters
    expect(ops).toContainEqual({ op: 'in', column: 'status', value: ACTIVE_CALL_STATUSES })
    // ended_at IS NULL — a finalized call is never "live".
    expect(ops).toContainEqual({ op: 'is', column: 'ended_at', value: null })
    // created_at bounded to the freshness window — stranded rows drop off.
    const recency = ops.find((f) => f.op === 'gte' && f.column === 'created_at')
    expect(recency).toBeDefined()
  })

  it('cuts off at the freshness window, not the start of today', () => {
    const q = fakeQuery()
    const before = Date.now()
    applyCallMetric(q, 'active', TODAY)
    const after = Date.now()

    const recency = q.filters.find((f) => f.op === 'gte' && f.column === 'created_at')!
    const cutoff = new Date(recency.value as string).getTime()
    const windowMs = ACTIVE_CALL_MAX_AGE_MINUTES * 60 * 1000
    // The cutoff is ~30 min ago, and definitely not the start-of-today boundary.
    expect(cutoff).toBeGreaterThanOrEqual(before - windowMs - 1000)
    expect(cutoff).toBeLessThanOrEqual(after - windowMs + 1000)
    expect(recency.value).not.toBe(TODAY)
  })
})

describe('applyCallMetric — other cards are day-scoped and unchanged', () => {
  it('today filters on start-of-day only', () => {
    const q = fakeQuery()
    applyCallMetric(q, 'today', TODAY)
    expect(q.filters).toEqual([{ op: 'gte', column: 'created_at', value: TODAY }])
  })

  it('connected requires completed + real duration + today', () => {
    const q = fakeQuery()
    applyCallMetric(q, 'connected', TODAY)
    expect(q.filters).toContainEqual({ op: 'eq', column: 'status', value: 'completed' })
    expect(q.filters).toContainEqual({ op: 'gt', column: 'duration_seconds', value: 0 })
    expect(q.filters).toContainEqual({ op: 'gte', column: 'created_at', value: TODAY })
  })
})
