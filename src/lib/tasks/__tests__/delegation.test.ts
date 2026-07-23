import { describe, it, expect, vi } from 'vitest'
import { taskAiCapability, commitDelegation, type DelegableTask } from '@/lib/tasks/delegation'
import type { SupabaseClient } from '@supabase/supabase-js'

const ORG = 'org-1'

function task(overrides: Partial<DelegableTask> = {}): DelegableTask {
  return {
    id: 't1',
    kind: 'inbound_reply',
    status: 'open',
    lead_id: 'lead-1',
    conversation_id: 'conv-1',
    ...overrides,
  }
}

describe('taskAiCapability', () => {
  it('offers reply-shaped kinds that are live and have a conversation + lead', () => {
    for (const kind of ['inbound_reply', 'follow_up', 'sla_breach_review']) {
      const cap = taskAiCapability(task({ kind }))
      expect(cap.capable).toBe(true)
    }
  })

  it('declines non-reply kinds', () => {
    for (const kind of ['manual', 'list_call', 'callback', 'recommendation', 'call_review']) {
      expect(taskAiCapability(task({ kind })).capable).toBe(false)
    }
  })

  it('declines tasks already in a terminal status', () => {
    for (const status of ['done', 'dismissed', 'delegated_to_ai', 'taken_by_ai', 'expired']) {
      expect(taskAiCapability(task({ status })).capable).toBe(false)
    }
  })

  it('declines when there is no conversation or no lead to reply on', () => {
    expect(taskAiCapability(task({ conversation_id: null })).capable).toBe(false)
    expect(taskAiCapability(task({ lead_id: null })).capable).toBe(false)
  })

  it('allows a claimed task (still live)', () => {
    expect(taskAiCapability(task({ status: 'claimed' })).capable).toBe(true)
  })
})

// ── commitDelegation guard branches ──────────────────────────────────────────
// A minimal single-table stub: the only reads commit makes before its guards
// fire are `human_tasks` (the task) and `messages` (the latest-direction check).

type Row = Record<string, unknown>

function stub(tables: Record<string, Row[]>): SupabaseClient {
  function chain(table: string) {
    let single = false
    const filters: Array<[string, unknown]> = []
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push([col, val])
        return api
      },
      order: () => api,
      limit: () => api,
      in: () => api,
      update: () => api,
      maybeSingle: () => {
        single = true
        return resolve()
      },
    }
    function resolve() {
      const rows = (tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v))
      return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null })
    }
    return api
  }
  return { from: (t: string) => chain(t) } as unknown as SupabaseClient
}

const ACTOR = { id: 'user-1', label: 'Reception' }

describe('commitDelegation guards', () => {
  it('404s when the task is not found', async () => {
    const res = await commitDelegation(stub({ human_tasks: [] }), ORG, 't1', ACTOR)
    expect(res).toEqual({ ok: false, status: 404, reason: 'task_not_found' })
  })

  it('409s when the task is not delegable (wrong kind)', async () => {
    const res = await commitDelegation(
      stub({ human_tasks: [{ id: 't1', kind: 'manual', status: 'open', lead_id: 'l', conversation_id: 'c', organization_id: ORG, metadata: {} }] }),
      ORG,
      't1',
      ACTOR
    )
    expect(res).toEqual({ ok: false, status: 409, reason: 'task_not_delegable' })
  })

  it('409s when there is no stored preview draft to send', async () => {
    const res = await commitDelegation(
      stub({ human_tasks: [{ id: 't1', kind: 'inbound_reply', status: 'open', lead_id: 'l', conversation_id: 'c', organization_id: ORG, metadata: {} }] }),
      ORG,
      't1',
      ACTOR
    )
    expect(res).toEqual({ ok: false, status: 409, reason: 'no_preview' })
  })

  it('409s when the thread was already answered since preview', async () => {
    const res = await commitDelegation(
      stub({
        human_tasks: [{
          id: 't1', kind: 'inbound_reply', status: 'open', lead_id: 'l', conversation_id: 'c',
          organization_id: ORG,
          metadata: { ai_delegation: { draft: 'Hi there', channel: 'sms', agent: 'setter' } },
        }],
        messages: [{ conversation_id: 'c', direction: 'outbound' }],
      }),
      ORG,
      't1',
      ACTOR
    )
    expect(res).toEqual({ ok: false, status: 409, reason: 'already_answered' })
  })
})
