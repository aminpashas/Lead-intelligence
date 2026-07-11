import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock both automation engines — the tests assert WHEN they fire, not what
// they do (they have their own coverage).
vi.mock('@/lib/funnel/executor', () => ({
  executeStageTransition: vi.fn(async () => []),
}))
vi.mock('@/lib/campaigns/stage-automation', () => ({
  onStageChange: vi.fn(async () => ({
    entryActionsExecuted: 0,
    campaignsTriggered: 0,
    campaignsExited: 0,
    errors: [],
  })),
}))

import { executeStageTransition } from '@/lib/funnel/executor'
import { onStageChange } from '@/lib/campaigns/stage-automation'
import { applyStageMove, chunk } from './stage-move'

const ORG_ID = 'org-1'
const TO_STAGE = { id: 'stage-to', name: 'Following Up', slug: 'following-up' }
const FROM_STAGE = { id: 'stage-from', name: 'New Lead', slug: 'new-lead' }

// ── Supabase mock ────────────────────────────────────────────────────────────
// Chainable, thenable query stubs keyed by table (same style as
// src/lib/__tests__/leads-dedupe.test.ts). Records lead updates and
// lead_activities inserts so tests can assert the audit trail.

function createMockSupabase(leads: Array<{ id: string; stage_id: string | null }>) {
  const activityInserts: Array<Record<string, unknown>> = []
  const leadUpdates: Array<{ payload: Record<string, unknown>; ids: string[] }> = []

  function makeChain(table: string) {
    const state: {
      op: 'select' | 'update' | 'insert'
      payload?: unknown
      inIds?: string[]
      eqs: Array<[string, unknown]>
    } = { op: 'select', eqs: [] }

    const resolveResult = () => {
      if (table === 'pipeline_stages') {
        return { data: [TO_STAGE, FROM_STAGE], error: null }
      }
      if (table === 'leads') {
        if (state.op === 'update') {
          leadUpdates.push({
            payload: state.payload as Record<string, unknown>,
            ids: state.inIds ?? [],
          })
          return { data: null, error: null }
        }
        const ids = new Set(state.inIds ?? [])
        return { data: leads.filter((l) => ids.has(l.id)), error: null }
      }
      if (table === 'lead_activities') {
        const rows = Array.isArray(state.payload) ? state.payload : [state.payload]
        activityInserts.push(...(rows as Array<Record<string, unknown>>))
        return { data: null, error: null }
      }
      return { data: null, error: null }
    }

    const chain: Record<string, unknown> = {
      select: vi.fn(() => chain),
      update: vi.fn((payload: unknown) => {
        state.op = 'update'
        state.payload = payload
        return chain
      }),
      insert: vi.fn((rows: unknown) => {
        state.op = 'insert'
        state.payload = rows
        return chain
      }),
      eq: vi.fn((col: string, val: unknown) => {
        state.eqs.push([col, val])
        return chain
      }),
      in: vi.fn((_col: string, ids: string[]) => {
        state.inIds = ids
        return chain
      }),
      maybeSingle: vi.fn(async () => {
        const idFilter = state.eqs.find(([col]) => col === 'id')?.[1]
        const stage = [TO_STAGE, FROM_STAGE].find((s) => s.id === idFilter) ?? null
        return { data: stage, error: null }
      }),
      then: (resolve: (v: unknown) => void) => resolve(resolveResult()),
    }
    return chain
  }

  return {
    client: { from: vi.fn((table: string) => makeChain(table)) },
    activityInserts,
    leadUpdates,
  }
}

const actor = { type: 'ai' as const, source: 'pipeline_recommendation' }

beforeEach(() => {
  vi.mocked(executeStageTransition).mockClear()
  vi.mocked(onStageChange).mockClear()
})

describe('chunk', () => {
  it('splits into bounded groups preserving order', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('returns no groups for an empty input', () => {
    expect(chunk([], 10)).toEqual([])
  })
})

describe('applyStageMove', () => {
  it('moves a single lead, writes the activity, and fires both automations', async () => {
    const mock = createMockSupabase([{ id: 'lead-1', stage_id: FROM_STAGE.id }])

    const result = await applyStageMove(mock.client as never, {
      organizationId: ORG_ID,
      leadIds: ['lead-1'],
      toStageId: TO_STAGE.id,
      actor,
    })

    expect(result.moved).toBe(1)
    expect(result.automationsFired).toBe(true)
    expect(result.error).toBeUndefined()

    expect(mock.leadUpdates).toHaveLength(1)
    expect(mock.leadUpdates[0]).toMatchObject({ payload: { stage_id: TO_STAGE.id }, ids: ['lead-1'] })

    expect(mock.activityInserts).toHaveLength(1)
    expect(mock.activityInserts[0]).toMatchObject({
      organization_id: ORG_ID,
      lead_id: 'lead-1',
      activity_type: 'stage_changed',
      title: `Moved to ${TO_STAGE.name}`,
      metadata: {
        from_stage: FROM_STAGE.id,
        to_stage: TO_STAGE.id,
        source: 'pipeline_recommendation',
        actor_type: 'ai',
        automations_fired: true,
      },
    })

    expect(executeStageTransition).toHaveBeenCalledTimes(1)
    expect(executeStageTransition).toHaveBeenCalledWith(
      mock.client,
      expect.objectContaining({
        organizationId: ORG_ID,
        leadId: 'lead-1',
        fromStageSlug: FROM_STAGE.slug,
        toStageSlug: TO_STAGE.slug,
      })
    )
    expect(onStageChange).toHaveBeenCalledTimes(1)
    expect(onStageChange).toHaveBeenCalledWith(
      mock.client,
      'lead-1',
      FROM_STAGE.slug,
      TO_STAGE.slug,
      ORG_ID
    )
  })

  it('fires automations for every lead in a bulk move', async () => {
    const leads = Array.from({ length: 25 }, (_, i) => ({
      id: `lead-${i}`,
      stage_id: FROM_STAGE.id,
    }))
    const mock = createMockSupabase(leads)

    const result = await applyStageMove(mock.client as never, {
      organizationId: ORG_ID,
      leadIds: leads.map((l) => l.id),
      toStageId: TO_STAGE.id,
      actor,
    })

    expect(result.moved).toBe(25)
    expect(executeStageTransition).toHaveBeenCalledTimes(25)
    expect(onStageChange).toHaveBeenCalledTimes(25)
    expect(mock.activityInserts).toHaveLength(25)
  })

  it('skips automations (but still moves + audits) when suppressed', async () => {
    const mock = createMockSupabase([
      { id: 'lead-1', stage_id: FROM_STAGE.id },
      { id: 'lead-2', stage_id: FROM_STAGE.id },
    ])

    const result = await applyStageMove(mock.client as never, {
      organizationId: ORG_ID,
      leadIds: ['lead-1', 'lead-2'],
      toStageId: TO_STAGE.id,
      actor,
      suppressAutomations: true,
    })

    expect(result.moved).toBe(2)
    expect(result.automationsFired).toBe(false)
    expect(executeStageTransition).not.toHaveBeenCalled()
    expect(onStageChange).not.toHaveBeenCalled()

    // The audit trail records the suppression choice on every row.
    expect(mock.activityInserts).toHaveLength(2)
    for (const row of mock.activityInserts) {
      expect((row.metadata as Record<string, unknown>).automations_fired).toBe(false)
    }
  })

  it('honors knownFromStageId over the (already-updated) row stage', async () => {
    // Per-lead PATCH flow: the row was updated before applyStageMove ran, so
    // the fetched stage_id is already the NEW stage.
    const mock = createMockSupabase([{ id: 'lead-1', stage_id: TO_STAGE.id }])

    await applyStageMove(mock.client as never, {
      organizationId: ORG_ID,
      leadIds: ['lead-1'],
      toStageId: TO_STAGE.id,
      actor: { type: 'user', userId: 'user-9', source: 'lead_update' },
      knownFromStageId: FROM_STAGE.id,
      activityTitle: 'Pipeline stage changed',
    })

    // Without knownFromStageId this would look like a no-op and skip automations.
    expect(executeStageTransition).toHaveBeenCalledTimes(1)
    expect(mock.activityInserts[0]).toMatchObject({
      title: 'Pipeline stage changed',
      metadata: expect.objectContaining({
        from_stage: FROM_STAGE.id,
        actor_type: 'user',
        actor_user_id: 'user-9',
      }),
    })
  })

  it('records a per-lead automation failure without killing the batch', async () => {
    vi.mocked(executeStageTransition).mockImplementation(async (_sb, params) => {
      if (params.leadId === 'lead-1') throw new Error('boom')
      return []
    })
    const mock = createMockSupabase([
      { id: 'lead-0', stage_id: FROM_STAGE.id },
      { id: 'lead-1', stage_id: FROM_STAGE.id },
      { id: 'lead-2', stage_id: FROM_STAGE.id },
    ])

    const result = await applyStageMove(mock.client as never, {
      organizationId: ORG_ID,
      leadIds: ['lead-0', 'lead-1', 'lead-2'],
      toStageId: TO_STAGE.id,
      actor,
    })

    expect(result.moved).toBe(3)
    expect(result.automationErrors).toEqual([{ leadId: 'lead-1', error: 'boom' }])
    // The other engine still ran for the failing lead, and both ran for the rest.
    expect(onStageChange).toHaveBeenCalledTimes(3)
    // The failure left an automation_error activity behind (3 moves + 1 error).
    const errorRows = mock.activityInserts.filter((r) => r.activity_type === 'automation_error')
    expect(errorRows).toHaveLength(1)
    expect(errorRows[0]).toMatchObject({
      lead_id: 'lead-1',
      title: 'Funnel automation failed',
    })
  })

  it('does not fire automations for a lead already in the target stage', async () => {
    const mock = createMockSupabase([
      { id: 'lead-1', stage_id: TO_STAGE.id }, // already there
      { id: 'lead-2', stage_id: FROM_STAGE.id },
    ])

    await applyStageMove(mock.client as never, {
      organizationId: ORG_ID,
      leadIds: ['lead-1', 'lead-2'],
      toStageId: TO_STAGE.id,
      actor,
    })

    expect(executeStageTransition).toHaveBeenCalledTimes(1)
    expect(vi.mocked(executeStageTransition).mock.calls[0][1].leadId).toBe('lead-2')
  })

  it('returns an error for an unknown target stage without touching leads', async () => {
    const mock = createMockSupabase([{ id: 'lead-1', stage_id: FROM_STAGE.id }])

    const result = await applyStageMove(mock.client as never, {
      organizationId: ORG_ID,
      leadIds: ['lead-1'],
      toStageId: 'no-such-stage',
      actor,
    })

    expect(result.error).toContain('no-such-stage')
    expect(result.moved).toBe(0)
    expect(mock.leadUpdates).toHaveLength(0)
    expect(mock.activityInserts).toHaveLength(0)
    expect(executeStageTransition).not.toHaveBeenCalled()
  })
})
