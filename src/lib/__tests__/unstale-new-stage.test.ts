import { describe, it, expect, vi } from 'vitest'
import {
  parkAgedNewLeads,
  newLeadMaxAgeDays,
  DEFAULT_NEW_LEAD_MAX_AGE_DAYS,
  PARK_CHUNK_SIZE,
} from '@/lib/pipeline/unstale-new-stage'

const ORG = 'fa64e53c-3d9b-493e-b904-59580cb3f29c'
const NEW_ID = 'stage-new'
const UNWORKED_ID = 'stage-no-comm'

const FULL_STAGES = [
  { id: NEW_ID, slug: 'new' },
  { id: UNWORKED_ID, slug: 'no-communication' },
  { id: 'stage-contacted', slug: 'contacted' },
]

type Filter = [string, ...unknown[]]
type Row = { id: string }

/**
 * Mock supabase for the chunked parkAgedNewLeads loop:
 *   from('pipeline_stages').select().eq()                       -> { data: stages }
 *   from('leads').select('id')...or().limit(n)                  -> next queued batch
 *   from('leads').update().in(ids).eq().select('id')            -> those ids, updated
 *   from('lead_activities').insert(rows)                        -> recorded
 *
 * `batches` is consumed one per loop iteration, so an empty batch terminates it.
 * Filters are recorded from the SELECT chain only (the UPDATE re-asserts stage_id
 * by design), so the safety predicate can be asserted exactly.
 */
function mockSupabase(
  stages: Array<{ id: string; slug: string }>,
  batches: Array<Row[]>,
  opts: { updateError?: string; selectError?: string } = {},
) {
  const calls = {
    filters: [] as Filter[],
    activities: [] as Array<Record<string, unknown>>,
    update: null as Record<string, unknown> | null,
    updateChunks: [] as string[][],
    limits: [] as number[],
  }
  let batchIdx = 0

  function builder(table: string) {
    let isUpdate = false
    let targetIds: string[] = []
    const chain: Record<string, unknown> = {
      select: vi.fn(() => chain),
      update: vi.fn((v: Record<string, unknown>) => {
        isUpdate = true
        calls.update = v
        return chain
      }),
      insert: vi.fn((rows: Array<Record<string, unknown>>) => {
        calls.activities.push(...rows)
        return Promise.resolve({ data: null, error: null })
      }),
      in: vi.fn((_c: string, v: string[]) => {
        targetIds = v
        calls.updateChunks.push(v)
        return chain
      }),
      limit: vi.fn((n: number) => {
        calls.limits.push(n)
        return chain
      }),
      eq: vi.fn((c: string, v: unknown) => {
        if (table === 'leads' && !isUpdate) calls.filters.push(['eq', c, v])
        return chain
      }),
      lt: vi.fn((c: string, v: unknown) => {
        calls.filters.push(['lt', c, v])
        return chain
      }),
      is: vi.fn((c: string, v: unknown) => {
        calls.filters.push(['is', c, v])
        return chain
      }),
      or: vi.fn((v: string) => {
        calls.filters.push(['or', v])
        return chain
      }),
      then: (resolve: (v: unknown) => void) => {
        if (table === 'pipeline_stages') return resolve({ data: stages, error: null })
        if (isUpdate) {
          return resolve({
            data: opts.updateError ? null : targetIds.map((id) => ({ id })),
            error: opts.updateError ? { message: opts.updateError } : null,
          })
        }
        if (opts.selectError) return resolve({ data: null, error: { message: opts.selectError } })
        return resolve({ data: batches[batchIdx++] ?? [], error: null })
      },
    }
    return chain
  }
  return { api: { from: vi.fn((t: string) => builder(t)) } as never, calls }
}

describe('newLeadMaxAgeDays', () => {
  it('defaults to a 7-day window when unset', () => {
    expect(newLeadMaxAgeDays({} as NodeJS.ProcessEnv)).toBe(DEFAULT_NEW_LEAD_MAX_AGE_DAYS)
    expect(DEFAULT_NEW_LEAD_MAX_AGE_DAYS).toBe(7)
  })
  it('honours a valid env override', () => {
    expect(newLeadMaxAgeDays({ NEW_LEAD_MAX_AGE_DAYS: '14' } as unknown as NodeJS.ProcessEnv)).toBe(14)
  })
  it('falls back to the default on a non-numeric or non-positive value', () => {
    expect(newLeadMaxAgeDays({ NEW_LEAD_MAX_AGE_DAYS: 'soon' } as unknown as NodeJS.ProcessEnv)).toBe(7)
    expect(newLeadMaxAgeDays({ NEW_LEAD_MAX_AGE_DAYS: '0' } as unknown as NodeJS.ProcessEnv)).toBe(7)
    expect(newLeadMaxAgeDays({ NEW_LEAD_MAX_AGE_DAYS: '-3' } as unknown as NodeJS.ProcessEnv)).toBe(7)
  })
})

describe('parkAgedNewLeads', () => {
  it('moves aged un-worked leads from New Lead to the un-worked queue', async () => {
    const { api, calls } = mockSupabase(FULL_STAGES, [[{ id: 'l1' }, { id: 'l2' }], []])

    const report = await parkAgedNewLeads(api, ORG, { now: new Date('2026-07-16T00:00:00.000Z') })

    expect(report.status).toBe('ok')
    expect(report.parked).toBe(2)
    // Target is the un-worked queue — NOT nurturing (reserved for worked-then-cold).
    expect(calls.update).toEqual({ stage_id: UNWORKED_ID })
  })

  it('computes the cutoff from maxAgeDays and filters created_at below it', async () => {
    const { api, calls } = mockSupabase(FULL_STAGES, [[]])
    const report = await parkAgedNewLeads(api, ORG, {
      now: new Date('2026-07-16T00:00:00.000Z'),
      maxAgeDays: 7,
    })

    expect(report.cutoff).toBe('2026-07-09T00:00:00.000Z')
    expect(calls.filters).toContainEqual(['lt', 'created_at', '2026-07-09T00:00:00.000Z'])
  })

  it('only ever touches leads that are un-worked on every signal', async () => {
    const { api, calls } = mockSupabase(FULL_STAGES, [[]])
    await parkAgedNewLeads(api, ORG, { now: new Date('2026-07-16T00:00:00.000Z') })

    // Scoped to the New Lead stage and the untouched default status.
    expect(calls.filters).toContainEqual(['eq', 'stage_id', NEW_ID])
    expect(calls.filters).toContainEqual(['eq', 'status', 'new'])
    // No human/AI contact of any kind, either direction.
    expect(calls.filters).toContainEqual(['is', 'last_contacted_at', null])
    expect(calls.filters).toContainEqual(['is', 'last_responded_at', null])
    // Null-safe counter checks (columns are nullable, default 0).
    expect(calls.filters).toContainEqual(['or', 'total_messages_sent.is.null,total_messages_sent.eq.0'])
    expect(calls.filters).toContainEqual(['or', 'total_messages_received.is.null,total_messages_received.eq.0'])
  })

  it('chunks the update so the per-row audit trigger cannot blow the statement timeout', async () => {
    const big = Array.from({ length: PARK_CHUNK_SIZE }, (_, i) => ({ id: `a${i}` }))
    const rest = [{ id: 'b0' }, { id: 'b1' }]
    const { api, calls } = mockSupabase(FULL_STAGES, [big, rest, []])

    const report = await parkAgedNewLeads(api, ORG, {})

    expect(report.parked).toBe(PARK_CHUNK_SIZE + 2)
    // One UPDATE per batch — never a single statement over the whole backlog.
    expect(calls.updateChunks).toHaveLength(2)
    expect(calls.updateChunks[0]).toHaveLength(PARK_CHUNK_SIZE)
    expect(calls.updateChunks[1]).toEqual(['b0', 'b1'])
    expect(calls.limits.every((n) => n === PARK_CHUNK_SIZE)).toBe(true)
  })

  it('honours an explicit chunkSize', async () => {
    const { api, calls } = mockSupabase(FULL_STAGES, [[{ id: 'l1' }], []])
    await parkAgedNewLeads(api, ORG, { chunkSize: 50 })
    expect(calls.limits[0]).toBe(50)
  })

  it('logs a stage_changed activity per parked lead', async () => {
    const { api, calls } = mockSupabase(FULL_STAGES, [[{ id: 'l1' }, { id: 'l2' }], []])
    await parkAgedNewLeads(api, ORG, {})

    expect(calls.activities).toHaveLength(2)
    expect(calls.activities[0]).toMatchObject({
      organization_id: ORG,
      lead_id: 'l1',
      activity_type: 'stage_changed',
    })
  })

  it('writes no activities when nothing is stale', async () => {
    const { api, calls } = mockSupabase(FULL_STAGES, [[]])
    const report = await parkAgedNewLeads(api, ORG, {})
    expect(report.parked).toBe(0)
    expect(calls.activities).toHaveLength(0)
  })

  // The whole point of this pass is to disprove "nothing is stale" — a swallowed
  // error is indistinguishable from that, so it must be loud.
  it('throws rather than silently reporting zero when the update fails', async () => {
    const { api } = mockSupabase(FULL_STAGES, [[{ id: 'l1' }], []], {
      updateError: 'canceling statement due to statement timeout',
    })
    await expect(parkAgedNewLeads(api, ORG, {})).rejects.toThrow(/statement timeout/)
  })

  it('throws rather than silently reporting zero when the select fails', async () => {
    const { api } = mockSupabase(FULL_STAGES, [[{ id: 'l1' }]], { selectError: 'boom' })
    await expect(parkAgedNewLeads(api, ORG, {})).rejects.toThrow(/select failed: boom/)
  })

  it('skips (never guesses a target) when the org has no un-worked queue stage', async () => {
    const { api, calls } = mockSupabase([{ id: NEW_ID, slug: 'new' }], [[{ id: 'l1' }]])
    const report = await parkAgedNewLeads(api, ORG, {})

    expect(report.status).toBe('skipped')
    expect(report.reason).toBe('missing_core_stages')
    expect(report.parked).toBe(0)
    expect(calls.update).toBeNull()
  })

  it('skips when the org has no New Lead stage', async () => {
    const { api, calls } = mockSupabase([{ id: UNWORKED_ID, slug: 'no-communication' }], [[{ id: 'l1' }]])
    const report = await parkAgedNewLeads(api, ORG, {})

    expect(report.status).toBe('skipped')
    expect(report.reason).toBe('missing_core_stages')
    expect(calls.update).toBeNull()
  })
})
