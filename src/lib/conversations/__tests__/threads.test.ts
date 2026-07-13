import { describe, it, expect, vi } from 'vitest'
import {
  claimConversationWorkflow,
  releaseConversationWorkflow,
  withConversationWorkflowLock,
  getOrCreateThread,
  inferTopic,
} from '@/lib/conversations/threads'

/**
 * Minimal Supabase stub: routes `.rpc(name, args)` to a handler map and gives a
 * chainable query builder whose terminal (`maybeSingle`/`single`) resolves to a
 * per-table scripted result. Enough to exercise the lock RPCs and thread
 * get-or-create without a real database.
 */
function fakeSupabase(opts: {
  rpc?: (name: string, args: any) => { data: any; error: any }
  onInsert?: (table: string, row: any) => void
  selectResult?: (table: string) => { data: any; error: any }
  insertResult?: (table: string) => { data: any; error: any }
}) {
  const rpcCalls: Array<{ name: string; args: any }> = []
  const supabase: any = {
    rpc(name: string, args: any) {
      rpcCalls.push({ name, args })
      const r = opts.rpc?.(name, args) ?? { data: null, error: null }
      return Promise.resolve(r)
    },
    from(table: string) {
      const builder: any = {
        _insertRow: null as any,
        insert(row: any) {
          builder._insertRow = row
          opts.onInsert?.(table, row)
          return builder
        },
        select() {
          return builder
        },
        eq() {
          return builder
        },
        limit() {
          return builder
        },
        maybeSingle() {
          return Promise.resolve(opts.selectResult?.(table) ?? { data: null, error: null })
        },
        single() {
          return Promise.resolve(opts.insertResult?.(table) ?? { data: null, error: null })
        },
      }
      return builder
    },
    __rpcCalls: rpcCalls,
  }
  return supabase
}

describe('claimConversationWorkflow', () => {
  it('reports acquired when the RPC grants the lease', async () => {
    const supabase = fakeSupabase({
      rpc: () => ({
        data: [{ acquired: true, holder: 'auto_respond', expires_at: '2026-07-13T00:02:00Z' }],
        error: null,
      }),
    })
    const r = await claimConversationWorkflow(supabase, {
      conversationId: 'c1',
      organizationId: 'o1',
      workflow: 'auto_respond',
    })
    expect(r.acquired).toBe(true)
    expect(r.holder).toBe('auto_respond')
    expect(supabase.__rpcCalls[0].name).toBe('claim_conversation_workflow')
    expect(supabase.__rpcCalls[0].args.p_workflow).toBe('auto_respond')
  })

  it('reports NOT acquired (with the incumbent) when a live lease is held by another workflow', async () => {
    const supabase = fakeSupabase({
      rpc: () => ({
        data: [{ acquired: false, holder: 'sequence', expires_at: '2026-07-13T00:02:00Z' }],
        error: null,
      }),
    })
    const r = await claimConversationWorkflow(supabase, {
      conversationId: 'c1',
      organizationId: 'o1',
      workflow: 'auto_respond',
    })
    expect(r.acquired).toBe(false)
    expect(r.holder).toBe('sequence')
  })

  it('fails OPEN when the RPC errors — a broken lock must never wedge sends', async () => {
    const supabase = fakeSupabase({
      rpc: () => ({ data: null, error: { message: 'function does not exist' } }),
    })
    const r = await claimConversationWorkflow(supabase, {
      conversationId: 'c1',
      organizationId: 'o1',
      workflow: 'auto_respond',
    })
    expect(r.acquired).toBe(true)
  })
})

describe('withConversationWorkflowLock', () => {
  it('runs fn while holding the lease and releases afterward', async () => {
    const supabase = fakeSupabase({
      rpc: (name) =>
        name === 'claim_conversation_workflow'
          ? { data: [{ acquired: true, holder: 'auto_respond', expires_at: 'x' }], error: null }
          : { data: true, error: null },
    })
    const fn = vi.fn().mockResolvedValue('sent')
    const out = await withConversationWorkflowLock(
      supabase,
      { conversationId: 'c1', organizationId: 'o1', workflow: 'auto_respond' },
      fn
    )
    expect(out).toEqual({ ran: true, result: 'sent' })
    expect(fn).toHaveBeenCalledOnce()
    // Both claim + release RPCs fired.
    const names = supabase.__rpcCalls.map((c: any) => c.name)
    expect(names).toContain('claim_conversation_workflow')
    expect(names).toContain('release_conversation_workflow')
  })

  it('does NOT run fn when another workflow holds the conversation', async () => {
    const supabase = fakeSupabase({
      rpc: () => ({
        data: [{ acquired: false, holder: 'sequence', expires_at: 'x' }],
        error: null,
      }),
    })
    const fn = vi.fn().mockResolvedValue('sent')
    const out = await withConversationWorkflowLock(
      supabase,
      { conversationId: 'c1', organizationId: 'o1', workflow: 'auto_respond' },
      fn
    )
    expect(out).toEqual({ ran: false, holder: 'sequence' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('releases the lease even when fn throws', async () => {
    const supabase = fakeSupabase({
      rpc: (name) =>
        name === 'claim_conversation_workflow'
          ? { data: [{ acquired: true, holder: 'auto_respond', expires_at: 'x' }], error: null }
          : { data: true, error: null },
    })
    const fn = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(
      withConversationWorkflowLock(
        supabase,
        { conversationId: 'c1', organizationId: 'o1', workflow: 'auto_respond' },
        fn
      )
    ).rejects.toThrow('boom')
    expect(supabase.__rpcCalls.map((c: any) => c.name)).toContain('release_conversation_workflow')
  })
})

describe('releaseConversationWorkflow', () => {
  it('calls the release RPC with the conversation + holder', async () => {
    const supabase = fakeSupabase({ rpc: () => ({ data: true, error: null }) })
    await releaseConversationWorkflow(supabase, 'c1', 'sequence')
    expect(supabase.__rpcCalls[0]).toEqual({
      name: 'release_conversation_workflow',
      args: { p_conversation_id: 'c1', p_workflow: 'sequence' },
    })
  })
})

describe('getOrCreateThread', () => {
  it('returns the existing open thread for a topic without inserting', async () => {
    const onInsert = vi.fn()
    const existing = { id: 't1', topic: 'scheduling', status: 'open' }
    const supabase = fakeSupabase({
      selectResult: () => ({ data: existing, error: null }),
      onInsert,
    })
    const t = await getOrCreateThread(supabase, {
      conversationId: 'c1',
      organizationId: 'o1',
      leadId: 'l1',
      topic: 'scheduling',
    })
    expect(t?.id).toBe('t1')
    expect(onInsert).not.toHaveBeenCalled()
  })

  it('creates a thread when none is open for the topic', async () => {
    const created = { id: 't2', topic: 'nurture', status: 'open' }
    const supabase = fakeSupabase({
      selectResult: () => ({ data: null, error: null }),
      insertResult: () => ({ data: created, error: null }),
    })
    const t = await getOrCreateThread(supabase, {
      conversationId: 'c1',
      organizationId: 'o1',
      leadId: 'l1',
      topic: 'nurture',
      openedBy: 'sequence',
    })
    expect(t?.id).toBe('t2')
  })

  it('re-selects the winner when a concurrent insert loses the unique race', async () => {
    const winner = { id: 't3', topic: 'scheduling', status: 'open' }
    let selectCall = 0
    const supabase = fakeSupabase({
      // First select (pre-insert) finds nothing; second (post-conflict) finds the winner.
      selectResult: () => {
        selectCall++
        return selectCall === 1 ? { data: null, error: null } : { data: winner, error: null }
      },
      // Insert fails on the partial unique index.
      insertResult: () => ({ data: null, error: { code: '23505', message: 'duplicate key' } }),
    })
    const t = await getOrCreateThread(supabase, {
      conversationId: 'c1',
      organizationId: 'o1',
      leadId: 'l1',
      topic: 'scheduling',
    })
    expect(t?.id).toBe('t3')
  })
})

describe('inferTopic', () => {
  it('detects scheduling intent', () => {
    expect(inferTopic('Does Tuesday at 9am work for you?')).toBe('scheduling')
    expect(inferTopic('can we reschedule my appointment')).toBe('scheduling')
  })

  it('detects financing intent', () => {
    expect(inferTopic('how much does it cost and do you take insurance?')).toBe('financing')
    expect(inferTopic('is there a monthly payment plan')).toBe('financing')
  })

  it('detects clinical intent', () => {
    expect(inferTopic('I have a lot of pain and swelling after the procedure')).toBe('clinical')
  })

  it('falls back to the stored conversation intent, then general', () => {
    expect(inferTopic('ok sounds good', 'ready_to_book')).toBe('scheduling')
    expect(inferTopic('ok', 'price_shopping')).toBe('financing')
    expect(inferTopic('hi there')).toBe('general')
  })
})
