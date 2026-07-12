/**
 * lead_ids static-snapshot criteria — the primitive behind Action Center
 * cohort materialization (SQL-only cohorts pinned into a Smart List).
 */

import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { smartListCriteriaSchema } from '@/lib/validators/smart-list'
import { applySmartListCriteria } from '@/lib/campaigns/smart-list-resolver'
import type { SmartListCriteria } from '@/types/database'

/** Minimal PostgREST-builder stand-in that records applied filters. */
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
  ) as { calls: typeof calls } & Record<string, (...args: unknown[]) => unknown>
  return q
}

describe('smartListCriteriaSchema lead_ids', () => {
  it('accepts a list of uuids', () => {
    const ids = [randomUUID(), randomUUID()]
    const parsed = smartListCriteriaSchema.safeParse({ lead_ids: ids })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.lead_ids).toEqual(ids)
  })

  it('rejects non-uuid entries', () => {
    expect(smartListCriteriaSchema.safeParse({ lead_ids: ['not-a-uuid'] }).success).toBe(false)
  })

  it('rejects an empty array (use omission instead)', () => {
    expect(smartListCriteriaSchema.safeParse({ lead_ids: [] }).success).toBe(false)
  })

  it('rejects more than 1000 ids (resolver .in() cap)', () => {
    const ids = Array.from({ length: 1001 }, () => randomUUID())
    expect(smartListCriteriaSchema.safeParse({ lead_ids: ids }).success).toBe(false)
  })
})

describe('applySmartListCriteria lead_ids', () => {
  it('pins the query to the id set', () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    const q = fakeQuery()
    applySmartListCriteria(q, { lead_ids: ids })
    expect(q.calls).toContainEqual({ method: 'in', args: ['id', ids] })
  })

  it('combines with other criteria (AND semantics)', () => {
    const ids = [randomUUID()]
    const criteria: SmartListCriteria = { lead_ids: ids, sms_consent: true, has_phone: true }
    const q = fakeQuery()
    applySmartListCriteria(q, criteria)
    const methods = q.calls.map((c) => `${c.method}:${c.args[0]}`)
    expect(methods).toContain('in:id')
    expect(methods).toContain('eq:sms_consent')
    expect(methods).toContain('not:phone_formatted')
  })

  it('is a no-op when lead_ids is absent', () => {
    const q = fakeQuery()
    applySmartListCriteria(q, {})
    expect(q.calls.find((c) => c.method === 'in' && c.args[0] === 'id')).toBeUndefined()
  })

  it('truncates past the 1000-id cap instead of building an unbounded filter', () => {
    const ids = Array.from({ length: 1200 }, () => randomUUID())
    const q = fakeQuery()
    // Bypasses zod (defense in depth for criteria already stored in jsonb).
    applySmartListCriteria(q, { lead_ids: ids } as SmartListCriteria)
    const inCall = q.calls.find((c) => c.method === 'in' && c.args[0] === 'id')
    expect((inCall?.args[1] as string[]).length).toBe(1000)
  })
})
