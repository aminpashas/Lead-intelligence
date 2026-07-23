import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  task: { id: 't1', status: 'open', claimed_by: null, due_at: null } as Record<string, unknown>,
  updateArgs: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: state.task }) }),
        }),
      }),
      update: (args: Record<string, unknown>) => {
        state.updateArgs = args
        return {
          eq: () => ({
            eq: () => ({
              select: () => ({ single: async () => ({ data: { id: 't1', ...args }, error: null }) }),
            }),
          }),
        }
      },
    }),
  })),
}))
vi.mock('@/lib/auth/active-org', () => ({
  getOwnProfile: vi.fn(async () => ({ data: { id: 'user-1', organization_id: 'org-1' } })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: 'org-1' })),
}))
vi.mock('@/lib/webhooks/verify', () => ({ applyRateLimit: () => null }))
vi.mock('@/lib/rate-limit', () => ({ RATE_LIMITS: { api: {} } }))

import { PATCH } from './route'

function req(body: unknown) {
  return new NextRequest('http://t/api/tasks/t1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}
const params = Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' })

beforeEach(() => {
  state.task = { id: 't1', status: 'open', claimed_by: null, due_at: null }
  state.updateArgs = null
})

describe('PATCH /api/tasks/[id] review', () => {
  it('sets reviewed_at/reviewed_by and leaves status unchanged', async () => {
    const res = await PATCH(req({ action: 'review' }), { params })
    expect(res.status).toBe(200)
    expect(state.updateArgs).toMatchObject({ reviewed_by: 'user-1' })
    expect(state.updateArgs?.reviewed_at).toEqual(expect.any(String))
    expect(state.updateArgs).not.toHaveProperty('status')
  })

  it('409s on a terminal task', async () => {
    state.task = { id: 't1', status: 'done', claimed_by: null, due_at: null }
    const res = await PATCH(req({ action: 'review' }), { params })
    expect(res.status).toBe(409)
  })
})

describe('PATCH /api/tasks/[id] snooze', () => {
  it('moves due_at ~N days out and stamps reviewed_at', async () => {
    const res = await PATCH(req({ action: 'snooze', snooze_days: 7 }), { params })
    expect(res.status).toBe(200)
    const due = new Date(state.updateArgs?.due_at as string).getTime()
    const now = Date.now()
    expect(due).toBeGreaterThan(now + 6.5 * 864e5)
    expect(due).toBeLessThan(now + 7.5 * 864e5)
    expect(state.updateArgs?.reviewed_at).toEqual(expect.any(String))
  })

  it('400s when neither snooze_days nor due_at is given', async () => {
    const res = await PATCH(req({ action: 'snooze' }), { params })
    expect(res.status).toBe(400)
  })

  it('400s on a past due_at', async () => {
    const res = await PATCH(req({ action: 'snooze', due_at: '2020-01-01T00:00:00.000Z' }), { params })
    expect(res.status).toBe(400)
  })
})
