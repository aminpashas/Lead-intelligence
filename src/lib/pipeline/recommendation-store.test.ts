import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  syncRecommendations,
  listOpenRecommendations,
  rowToRecommendation,
  type PipelineRecommendationRow,
  type StoredExecution,
} from './recommendation-store'
import { buildExecution, type Recommendation } from './recommendations'

const ORG_ID = 'org-1'
const NOW_MS = Date.parse('2026-07-11T12:00:00.000Z')

// ── Supabase mock ────────────────────────────────────────────────────────────
// Chainable, thenable query stubs (same style as stage-move.test.ts). Records
// updates/inserts against pipeline_recommendations so tests assert the writes.

type Recorded = {
  updates: Array<{ payload: Record<string, unknown>; eqId?: string; inIds?: string[] }>
  inserts: Array<Record<string, unknown>>
}

function createMockSupabase(openRows: Array<Record<string, unknown>>) {
  const recorded: Recorded = { updates: [], inserts: [] }

  function makeChain() {
    const state: {
      op: 'select' | 'update' | 'insert'
      payload?: Record<string, unknown>
      eqs: Array<[string, unknown]>
      inIds?: string[]
    } = { op: 'select', eqs: [] }

    const resolveResult = () => {
      if (state.op === 'update') {
        recorded.updates.push({
          payload: state.payload!,
          eqId: state.eqs.find(([col]) => col === 'id')?.[1] as string | undefined,
          inIds: state.inIds,
        })
        return { data: null, error: null }
      }
      if (state.op === 'insert') {
        recorded.inserts.push(state.payload!)
        return { data: null, error: null }
      }
      return { data: openRows, error: null }
    }

    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'or', 'order', 'limit']) {
      chain[method] = (...args: unknown[]) => {
        if (method === 'eq') state.eqs.push([args[0] as string, args[1]])
        return chain
      }
    }
    chain.update = (payload: Record<string, unknown>) => {
      state.op = 'update'
      state.payload = payload
      return chain
    }
    chain.insert = (payload: Record<string, unknown>) => {
      state.op = 'insert'
      state.payload = payload
      return chain
    }
    chain.in = (_col: string, ids: string[]) => {
      state.inIds = ids
      return chain
    }
    chain.maybeSingle = () => Promise.resolve({ data: openRows[0] ?? null, error: null })
    chain.then = (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown
    ) => Promise.resolve(resolveResult()).then(resolve, reject)

    return chain
  }

  const supabase = { from: () => makeChain() } as unknown as SupabaseClient
  return { supabase, recorded }
}

function makeRec(overrides: Partial<Recommendation> & { id: string }): Recommendation {
  const criteria = { stages: ['stage-1'], has_phone: true, sms_consent: true }
  return {
    kind: 'strike_hot',
    priority: 72,
    title: 'Text 10 hot & warm leads',
    detail: 'High-intent leads.',
    leadCount: 10,
    cta: 'Text hot leads now',
    action: { type: 'broadcast', channel: 'sms', segmentName: 'Hot & warm', criteria },
    expectedValueUsd: 5000,
    avgCloseProbability: 0.21,
    evidence: [{ metric: 'hot_warm_reachable_sms', value: 10, source: 'test' }],
    execution: buildExecution('strike_hot', criteria),
    ...overrides,
  }
}

// ── syncRecommendations ──────────────────────────────────────────────────────

describe('syncRecommendations', () => {
  it('inserts a new open row for a key with no existing open row', async () => {
    const { supabase, recorded } = createMockSupabase([])
    const result = await syncRecommendations(supabase, ORG_ID, [makeRec({ id: 'strike_hot:s1' })], NOW_MS)

    expect(result).toEqual({ inserted: 1, refreshed: 0, expired: 0 })
    expect(recorded.inserts).toHaveLength(1)
    const row = recorded.inserts[0]
    expect(row.organization_id).toBe(ORG_ID)
    expect(row.dedupe_key).toBe('strike_hot:s1')
    expect(row.origin).toBe('rules')
    expect(row.status).toBe('open')
    expect(row.lead_count).toBe(10)
    expect(row.priority).toBe(72)
    // expires_at = now + 24h.
    expect(row.expires_at).toBe(new Date(NOW_MS + 24 * 60 * 60 * 1000).toISOString())
    // UI round-trip payload rides inside execution.presentation.
    const execution = row.execution as StoredExecution
    expect(execution.executor).toBe('setter_ai')
    expect(execution.presentation.cta).toBe('Text hot leads now')
    expect(execution.presentation.action).toEqual(
      expect.objectContaining({ type: 'broadcast', segmentName: 'Hot & warm' })
    )
  })

  it('refreshes an existing open row in place instead of duplicating', async () => {
    const { supabase, recorded } = createMockSupabase([
      { id: 'row-1', dedupe_key: 'strike_hot:s1' },
    ])
    const result = await syncRecommendations(
      supabase,
      ORG_ID,
      [makeRec({ id: 'strike_hot:s1', leadCount: 42, priority: 88 })],
      NOW_MS
    )

    expect(result).toEqual({ inserted: 0, refreshed: 1, expired: 0 })
    expect(recorded.inserts).toHaveLength(0)
    expect(recorded.updates).toHaveLength(1)
    expect(recorded.updates[0].eqId).toBe('row-1')
    expect(recorded.updates[0].payload.lead_count).toBe(42)
    expect(recorded.updates[0].payload.priority).toBe(88)
    expect(recorded.updates[0].payload.expires_at).toBe(
      new Date(NOW_MS + 24 * 60 * 60 * 1000).toISOString()
    )
  })

  it('expires open rows whose dedupe_key stopped being produced', async () => {
    const { supabase, recorded } = createMockSupabase([
      { id: 'row-live', dedupe_key: 'strike_hot:s1' },
      { id: 'row-stale', dedupe_key: 'follow_up:s2' },
    ])
    const result = await syncRecommendations(supabase, ORG_ID, [makeRec({ id: 'strike_hot:s1' })], NOW_MS)

    expect(result).toEqual({ inserted: 0, refreshed: 1, expired: 1 })
    const expire = recorded.updates.find((u) => u.payload.status === 'expired')
    expect(expire).toBeDefined()
    expect(expire!.inIds).toEqual(['row-stale'])
  })

  it('handles an empty engine output by expiring everything open', async () => {
    const { supabase, recorded } = createMockSupabase([
      { id: 'row-a', dedupe_key: 'strike_hot:s1' },
      { id: 'row-b', dedupe_key: 're_engage:s3' },
    ])
    const result = await syncRecommendations(supabase, ORG_ID, [], NOW_MS)

    expect(result).toEqual({ inserted: 0, refreshed: 0, expired: 2 })
    expect(recorded.updates[0].inIds).toEqual(['row-a', 'row-b'])
  })

  it('rounds avg_close_probability to numeric(4,3) precision', async () => {
    const { supabase, recorded } = createMockSupabase([])
    await syncRecommendations(
      supabase,
      ORG_ID,
      [makeRec({ id: 'strike_hot:s1', avgCloseProbability: 0.123456 })],
      NOW_MS
    )
    expect(recorded.inserts[0].avg_close_probability).toBe(0.123)
  })
})

// ── listOpenRecommendations / rowToRecommendation ────────────────────────────

function makeRow(overrides: Partial<PipelineRecommendationRow> = {}): PipelineRecommendationRow {
  const criteria = { stages: ['stage-1'], has_phone: true, sms_consent: true }
  const action = {
    type: 'broadcast' as const,
    channel: 'sms' as const,
    segmentName: 'Hot & warm',
    criteria,
  }
  return {
    id: 'row-1',
    organization_id: ORG_ID,
    dedupe_key: 'strike_hot:stage-1',
    kind: 'strike_hot',
    origin: 'rules',
    title: 'Text 10 hot & warm leads',
    detail: 'High-intent leads.',
    segment_criteria: criteria,
    lead_count: 10,
    expected_value_usd: '5000.5', // PostgREST numerics arrive as strings
    avg_close_probability: '0.210',
    evidence: [{ metric: 'hot_warm_reachable_sms', value: 10, source: 'test' }],
    execution: {
      ...buildExecution('strike_hot', criteria),
      presentation: { action, cta: 'Text hot leads now' },
    },
    priority: 87,
    status: 'open',
    expires_at: new Date(NOW_MS + 3_600_000).toISOString(),
    ...overrides,
  }
}

describe('rowToRecommendation', () => {
  it('round-trips a persisted row to the band component shape', () => {
    const rec = rowToRecommendation(makeRow())
    expect(rec.id).toBe('strike_hot:stage-1') // id = dedupe_key for apply/dismiss
    expect(rec.recommendationId).toBe('row-1')
    expect(rec.kind).toBe('strike_hot')
    expect(rec.leadCount).toBe(10)
    expect(rec.cta).toBe('Text hot leads now')
    expect(rec.action).toEqual(
      expect.objectContaining({ type: 'broadcast', segmentName: 'Hot & warm' })
    )
    expect(rec.expectedValueUsd).toBe(5000.5) // string → number
    expect(rec.avgCloseProbability).toBe(0.21)
  })

  it('falls back to a review-first broadcast when presentation is missing', () => {
    const row = makeRow()
    row.execution = { ...row.execution, presentation: undefined as never }
    const rec = rowToRecommendation(row)
    expect(rec.action.type).toBe('broadcast')
    expect(rec.action.criteria).toEqual(row.segment_criteria)
    expect(rec.cta).toBe('Review segment')
  })
})

describe('listOpenRecommendations', () => {
  it('maps rows and sorts by priority desc, EV desc on ties', async () => {
    const rows = [
      makeRow({ id: 'r1', dedupe_key: 'a:1', priority: 60, expected_value_usd: '10' }),
      makeRow({ id: 'r2', dedupe_key: 'b:1', priority: 90, expected_value_usd: null }),
      makeRow({ id: 'r3', dedupe_key: 'c:1', priority: 60, expected_value_usd: '9000' }),
    ]
    const { supabase } = createMockSupabase(rows)
    const recs = await listOpenRecommendations(supabase, ORG_ID, NOW_MS)
    expect(recs.map((r) => r.recommendationId)).toEqual(['r2', 'r3', 'r1'])
  })

  it('returns [] on query failure so the page can fall back to live compute', async () => {
    const supabase = {
      from: () => {
        throw new Error('boom')
      },
    } as unknown as SupabaseClient
    expect(await listOpenRecommendations(supabase, ORG_ID, NOW_MS)).toEqual([])
  })
})
