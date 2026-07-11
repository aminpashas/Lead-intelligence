import { describe, it, expect, vi } from 'vitest'
import {
  createHumanTask,
  resolveAssignee,
  completeTasksForConversation,
  taskDedupeKeyForInbound,
  taskDedupeKeyForFirstTouch,
  type CreateHumanTaskInput,
} from '@/lib/automation/tasks'
import type { SupabaseClient } from '@supabase/supabase-js'

const ORG_ID = 'org-1'

// ── Supabase mock ────────────────────────────────────────────────────────────
// Chainable, thenable query stubs keyed by table with an in-memory human_tasks
// store (same style as src/lib/pipeline/stage-move.test.ts). Records inserts
// and updates so tests can assert dedupe/refresh behavior.

type TaskRow = Record<string, unknown> & { id: string; status: string }

function createMockSupabase(
  opts: {
    tasks?: TaskRow[]
    leads?: Record<string, { assigned_to: string | null }>
    users?: Array<{ id: string; organization_id: string; role: string; is_active: boolean }>
    /** Simulate the dedupe race: first insert fails 23505 and this row appears
     *  in the store (the "other writer" won). */
    raceWinnerRow?: TaskRow
  } = {}
) {
  const tasks: TaskRow[] = [...(opts.tasks ?? [])]
  const inserts: Array<Record<string, unknown>> = []
  const updates: Array<{ payload: Record<string, unknown> }> = []
  let racePending = !!opts.raceWinnerRow
  let idCounter = 0

  function makeChain(table: string) {
    const state: {
      op: 'select' | 'insert' | 'update'
      payload?: Record<string, unknown>
      eqs: Array<[string, unknown]>
      ins: Array<[string, unknown[]]>
      isNull: string[]
    } = { op: 'select', eqs: [], ins: [], isNull: [] }

    const matches = (row: Record<string, unknown>) =>
      state.eqs.every(([col, val]) => row[col] === val) &&
      state.ins.every(([col, vals]) => vals.includes(row[col])) &&
      state.isNull.every((col) => row[col] == null)

    const run = (): { data: unknown; error: { code?: string; message: string } | null } => {
      if (table === 'human_tasks') {
        if (state.op === 'insert') {
          if (racePending) {
            racePending = false
            tasks.push(opts.raceWinnerRow!)
            return { data: null, error: { code: '23505', message: 'duplicate key value' } }
          }
          const row: TaskRow = {
            id: `task-${++idCounter}`,
            ...(state.payload as Record<string, unknown>),
          } as TaskRow
          tasks.push(row)
          inserts.push(row)
          return { data: [{ id: row.id }], error: null }
        }
        if (state.op === 'update') {
          const hit = tasks.filter(matches)
          hit.forEach((r) => Object.assign(r, state.payload))
          updates.push({ payload: state.payload! })
          return { data: hit.map((r) => ({ id: r.id })), error: null }
        }
        return { data: tasks.filter(matches), error: null }
      }
      if (table === 'leads') {
        const id = state.eqs.find(([col]) => col === 'id')?.[1] as string | undefined
        const lead = id ? opts.leads?.[id] : undefined
        return { data: lead ? [lead] : [], error: null }
      }
      if (table === 'user_profiles') {
        const rows = (opts.users ?? []).filter((u) =>
          state.eqs.every(([col, val]) => (u as Record<string, unknown>)[col] === val)
        )
        return { data: rows, error: null }
      }
      return { data: [], error: null }
    }

    const chain: Record<string, unknown> = {
      select: vi.fn(() => chain),
      insert: vi.fn((payload: Record<string, unknown>) => {
        state.op = 'insert'
        state.payload = payload
        return chain
      }),
      update: vi.fn((payload: Record<string, unknown>) => {
        state.op = 'update'
        state.payload = payload
        return chain
      }),
      eq: vi.fn((col: string, val: unknown) => {
        state.eqs.push([col, val])
        return chain
      }),
      in: vi.fn((col: string, vals: unknown[]) => {
        state.ins.push([col, vals])
        return chain
      }),
      is: vi.fn((col: string) => {
        state.isNull.push(col)
        return chain
      }),
      limit: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => {
        const r = run()
        const rows = (r.data as Array<Record<string, unknown>>) ?? []
        return { data: rows[0] ?? null, error: r.error }
      }),
      single: vi.fn(async () => {
        const r = run()
        if (r.error) return { data: null, error: r.error }
        const rows = (r.data as Array<Record<string, unknown>>) ?? []
        return { data: rows[0] ?? null, error: null }
      }),
      then: (resolve: (v: unknown) => void) => resolve(run()),
    }
    return chain
  }

  return {
    client: { from: vi.fn((table: string) => makeChain(table)) } as unknown as SupabaseClient,
    tasks,
    inserts,
    updates,
  }
}

const baseInput = (overrides: Partial<CreateHumanTaskInput> = {}): CreateHumanTaskInput => ({
  organization_id: ORG_ID,
  kind: 'inbound_reply',
  title: 'Reply to Jane',
  source: 'allocation',
  lead_id: 'lead-1',
  conversation_id: 'convo-1',
  dedupe_key: taskDedupeKeyForInbound('convo-1'),
  ...overrides,
})

// ── Dedupe keys ──────────────────────────────────────────────────────────────

describe('dedupe key helpers', () => {
  it('builds the inbound and first-touch keys', () => {
    expect(taskDedupeKeyForInbound('c-9')).toBe('inbound:c-9')
    expect(taskDedupeKeyForFirstTouch('l-7')).toBe('first_touch:l-7')
  })
})

// ── createHumanTask ──────────────────────────────────────────────────────────

describe('createHumanTask', () => {
  it('two inbounds on the same conversation collapse into ONE open task', async () => {
    const supa = createMockSupabase()

    const first = await createHumanTask(supa.client, baseInput({ detail: 'first message' }))
    expect(first.taskId).toBeTruthy()
    expect(first.deduped).toBe(false)

    const second = await createHumanTask(supa.client, baseInput({ detail: 'second message' }))
    expect(second.taskId).toBe(first.taskId)
    expect(second.deduped).toBe(true)

    // Only one row was ever inserted; the second call refreshed it.
    expect(supa.inserts.length).toBe(1)
    const row = supa.tasks.find((t) => t.id === first.taskId)!
    expect(row.detail).toBe('second message')
    expect(row.status).toBe('open')
  })

  it('a completed task does NOT block a new task with the same key', async () => {
    const supa = createMockSupabase({
      tasks: [
        {
          id: 'task-done',
          organization_id: ORG_ID,
          dedupe_key: taskDedupeKeyForInbound('convo-1'),
          status: 'done',
        },
      ],
    })

    const result = await createHumanTask(supa.client, baseInput())
    expect(result.deduped).toBe(false)
    expect(result.taskId).not.toBe('task-done')
    expect(supa.inserts.length).toBe(1)
  })

  it('recovers from the dedupe race (23505) by refreshing the winner row', async () => {
    const winner: TaskRow = {
      id: 'task-winner',
      organization_id: ORG_ID,
      dedupe_key: taskDedupeKeyForInbound('convo-1'),
      status: 'open',
      detail: 'winner detail',
    }
    const supa = createMockSupabase({ raceWinnerRow: winner })

    const result = await createHumanTask(supa.client, baseInput({ detail: 'loser detail' }))
    expect(result.taskId).toBe('task-winner')
    expect(result.deduped).toBe(true)
    // The loser refreshed the winner's context instead of failing.
    expect(winner.detail).toBe('loser detail')
    expect(supa.inserts.length).toBe(0)
  })

  it('tasks without a dedupe_key never collapse', async () => {
    const supa = createMockSupabase()
    const a = await createHumanTask(supa.client, baseInput({ dedupe_key: null }))
    const b = await createHumanTask(supa.client, baseInput({ dedupe_key: null }))
    expect(a.taskId).not.toBe(b.taskId)
    expect(supa.inserts.length).toBe(2)
  })
})

// ── resolveAssignee ──────────────────────────────────────────────────────────

describe('resolveAssignee', () => {
  it('prefers the lead owner when active', async () => {
    const supa = createMockSupabase({
      leads: { 'lead-1': { assigned_to: 'user-1' } },
      users: [
        { id: 'user-1', organization_id: ORG_ID, role: 'treatment_coordinator', is_active: true },
        { id: 'admin-1', organization_id: ORG_ID, role: 'admin', is_active: true },
      ],
    })

    const result = await resolveAssignee(supa.client, ORG_ID, 'lead-1')
    expect(result.userId).toBe('user-1')
    expect(result.role).toBe('treatment_coordinator')
    expect(result.pool).toEqual(['user-1'])
  })

  it('skips an inactive lead owner and falls through the chain', async () => {
    const supa = createMockSupabase({
      leads: { 'lead-1': { assigned_to: 'user-1' } },
      users: [
        { id: 'user-1', organization_id: ORG_ID, role: 'manager', is_active: false },
        { id: 'admin-1', organization_id: ORG_ID, role: 'admin', is_active: true },
      ],
    })

    const result = await resolveAssignee(supa.client, ORG_ID, 'lead-1')
    expect(result.userId).toBeNull()
    expect(result.role).toBe('admin')
    expect(result.pool).toEqual(['admin-1'])
  })

  it('routes to the requested role pool before admins', async () => {
    const supa = createMockSupabase({
      users: [
        { id: 'tc-1', organization_id: ORG_ID, role: 'treatment_coordinator', is_active: true },
        { id: 'tc-2', organization_id: ORG_ID, role: 'treatment_coordinator', is_active: true },
        { id: 'admin-1', organization_id: ORG_ID, role: 'admin', is_active: true },
      ],
    })

    const result = await resolveAssignee(supa.client, ORG_ID, null, 'treatment_coordinator')
    expect(result.userId).toBeNull()
    expect(result.role).toBe('treatment_coordinator')
    expect(result.pool).toEqual(['tc-1', 'tc-2'])
  })

  it('returns empty when nobody is eligible', async () => {
    const supa = createMockSupabase({ users: [] })
    const result = await resolveAssignee(supa.client, ORG_ID, 'lead-1', 'nurse')
    expect(result).toEqual({ userId: null, role: null, pool: [] })
  })
})

// ── completeTasksForConversation ─────────────────────────────────────────────

describe('completeTasksForConversation', () => {
  it('closes the live inbound task and credits the completer as claimer', async () => {
    const supa = createMockSupabase({
      tasks: [
        {
          id: 'task-1',
          organization_id: ORG_ID,
          dedupe_key: taskDedupeKeyForInbound('convo-1'),
          status: 'open',
          claimed_by: null,
        },
        {
          id: 'task-other',
          organization_id: ORG_ID,
          dedupe_key: taskDedupeKeyForInbound('convo-2'),
          status: 'open',
          claimed_by: null,
        },
      ],
    })

    const closed = await completeTasksForConversation(supa.client, 'convo-1', 'user-9')
    expect(closed).toBe(1)

    const task = supa.tasks.find((t) => t.id === 'task-1')!
    expect(task.status).toBe('done')
    expect(task.completed_at).toBeTruthy()
    expect(task.claimed_by).toBe('user-9')

    // The other conversation's task is untouched.
    const other = supa.tasks.find((t) => t.id === 'task-other')!
    expect(other.status).toBe('open')
  })

  it('does not steal credit from an existing claimer', async () => {
    const supa = createMockSupabase({
      tasks: [
        {
          id: 'task-1',
          organization_id: ORG_ID,
          dedupe_key: taskDedupeKeyForInbound('convo-1'),
          status: 'claimed',
          claimed_by: 'user-1',
        },
      ],
    })

    const closed = await completeTasksForConversation(supa.client, 'convo-1', 'user-9')
    expect(closed).toBe(1)
    expect(supa.tasks[0].claimed_by).toBe('user-1')
    expect(supa.tasks[0].status).toBe('done')
  })

  it('supports the D3 takeover terminal status and ignores already-done tasks', async () => {
    const supa = createMockSupabase({
      tasks: [
        {
          id: 'task-1',
          organization_id: ORG_ID,
          dedupe_key: taskDedupeKeyForInbound('convo-1'),
          status: 'done',
          claimed_by: null,
        },
      ],
    })

    const closed = await completeTasksForConversation(supa.client, 'convo-1', null, 'taken_by_ai')
    expect(closed).toBe(0)
    expect(supa.tasks[0].status).toBe('done')
  })
})
