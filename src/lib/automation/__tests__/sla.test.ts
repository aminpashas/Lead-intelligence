import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// attemptTakeover re-runs the autopilot engine; mock it so tests exercise the
// SLA state machine, not the agent stack. (sla.ts imports it dynamically —
// vi.mock intercepts dynamic imports too.)
vi.mock('@/lib/autopilot/auto-respond', () => ({
  processAutoResponse: vi.fn(),
}))

import { processAutoResponse } from '@/lib/autopilot/auto-respond'
import {
  openResponseSla,
  closeSlaOnHumanReply,
  recordImmediateAiResponse,
  attemptTakeover,
  type MessageResponseSla,
  type TakeoverPayload,
} from '@/lib/automation/sla'

const processAutoResponseMock = vi.mocked(processAutoResponse)

const ORG_ID = 'org-1'
const CONVO_ID = 'convo-1'
const LEAD_ID = 'lead-1'

// ── Supabase mock ────────────────────────────────────────────────────────────
// Chainable, thenable query stubs over in-memory per-table stores (same style
// as tasks.test.ts), extended with gt/lte/order for the SLA queries.

type Row = Record<string, unknown>

function createMockSupabase(seed: Partial<Record<string, Row[]>> = {}) {
  const stores = new Map<string, Row[]>()
  for (const [t, rows] of Object.entries(seed)) {
    stores.set(t, (rows ?? []).map((r) => ({ ...r })))
  }
  const inserted: Record<string, Row[]> = {}
  let idCounter = 0

  const table = (name: string): Row[] => {
    if (!stores.has(name)) stores.set(name, [])
    return stores.get(name)!
  }

  function makeChain(tableName: string) {
    const state: {
      op: 'select' | 'insert' | 'update'
      payload?: Row
      eqs: Array<[string, unknown]>
      gts: Array<[string, string]>
      ins: Array<[string, unknown[]]>
      isNull: string[]
    } = { op: 'select', eqs: [], gts: [], ins: [], isNull: [] }

    const matches = (row: Row) =>
      state.eqs.every(([col, val]) => row[col] === val) &&
      state.gts.every(([col, val]) => String(row[col] ?? '') > val) &&
      state.ins.every(([col, vals]) => vals.includes(row[col])) &&
      state.isNull.every((col) => row[col] == null)

    const run = (): { data: Row[]; error: { message: string } | null } => {
      const rows = table(tableName)
      if (state.op === 'insert') {
        const row: Row = { id: `${tableName}-${++idCounter}`, ...state.payload }
        rows.push(row)
        ;(inserted[tableName] ??= []).push(row)
        return { data: [row], error: null }
      }
      if (state.op === 'update') {
        const hit = rows.filter(matches)
        hit.forEach((r) => Object.assign(r, state.payload))
        return { data: hit, error: null }
      }
      return { data: rows.filter(matches), error: null }
    }

    const chain: Record<string, unknown> = {
      select: vi.fn(() => chain),
      insert: vi.fn((payload: Row) => {
        state.op = 'insert'
        state.payload = payload
        return chain
      }),
      update: vi.fn((payload: Row) => {
        state.op = 'update'
        state.payload = payload
        return chain
      }),
      eq: vi.fn((col: string, val: unknown) => {
        state.eqs.push([col, val])
        return chain
      }),
      gt: vi.fn((col: string, val: string) => {
        state.gts.push([col, val])
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
      order: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => {
        const r = run()
        return { data: r.data[0] ?? null, error: r.error }
      }),
      single: vi.fn(async () => {
        const r = run()
        return r.data[0]
          ? { data: r.data[0], error: null }
          : { data: null, error: { message: 'not found' } }
      }),
      then: (resolve: (v: unknown) => void) => resolve(run()),
    }
    return chain
  }

  return {
    client: { from: vi.fn((t: string) => makeChain(t)) } as unknown as SupabaseClient,
    table,
    inserted,
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const payload = (overrides: Partial<TakeoverPayload> = {}): TakeoverPayload => ({
  organization_id: ORG_ID,
  conversation_id: CONVO_ID,
  lead_id: LEAD_ID,
  inbound_message: 'Is Saturday available?',
  channel: 'sms',
  sender_contact: '+15555550100',
  ...overrides,
})

/** A pending row whose deadline passed 2 minutes ago (inbound 5 minutes ago). */
const slaRow = (overrides: Partial<MessageResponseSla> = {}): MessageResponseSla => ({
  id: 'sla-1',
  organization_id: ORG_ID,
  conversation_id: CONVO_ID,
  lead_id: LEAD_ID,
  inbound_message_id: null,
  inbound_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  sla_seconds: 180,
  deadline_at: new Date(Date.now() - 2 * 60_000).toISOString(),
  status: 'pending',
  first_response_at: null,
  responder_type: null,
  sla_met: null,
  takeover_payload: payload(),
  takeover_error: null,
  metadata: {},
  created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  ...overrides,
})

beforeEach(() => {
  processAutoResponseMock.mockReset()
})

// ── openResponseSla ──────────────────────────────────────────────────────────

describe('openResponseSla', () => {
  it('computes deadline_at = inbound_at + sla_seconds', async () => {
    const supa = createMockSupabase()

    const id = await openResponseSla(supa.client, {
      organizationId: ORG_ID,
      conversationId: CONVO_ID,
      leadId: LEAD_ID,
      inboundMessageId: 'msg-1',
      slaSeconds: 180,
      takeoverPayload: payload(),
    })

    expect(id).toBeTruthy()
    const row = supa.table('message_response_slas')[0]
    expect(row.status).toBe('pending')
    expect(row.sla_seconds).toBe(180)
    const deadlineMs =
      new Date(row.deadline_at as string).getTime() -
      new Date(row.inbound_at as string).getTime()
    expect(deadlineMs).toBe(180 * 1000)
  })

  it('burst collapse: a second inbound keeps the original clock but refreshes the payload', async () => {
    const originalInboundAt = new Date(Date.now() - 60_000).toISOString()
    const originalDeadline = new Date(Date.now() + 120_000).toISOString()
    const supa = createMockSupabase({
      message_response_slas: [
        {
          id: 'sla-live',
          conversation_id: CONVO_ID,
          status: 'pending',
          inbound_at: originalInboundAt,
          deadline_at: originalDeadline,
          takeover_payload: payload({ inbound_message: 'first message' }),
        },
      ],
    })

    const id = await openResponseSla(supa.client, {
      organizationId: ORG_ID,
      conversationId: CONVO_ID,
      leadId: LEAD_ID,
      slaSeconds: 180,
      takeoverPayload: payload({ inbound_message: 'second message' }),
    })

    // Collapsed onto the live timer — no second row.
    expect(id).toBe('sla-live')
    expect(supa.inserted['message_response_slas']).toBeUndefined()

    const row = supa.table('message_response_slas')[0]
    // Clock untouched: it started at the first unanswered inbound.
    expect(row.inbound_at).toBe(originalInboundAt)
    expect(row.deadline_at).toBe(originalDeadline)
    // Payload refreshed: the takeover replies to the LATEST message.
    expect((row.takeover_payload as TakeoverPayload).inbound_message).toBe('second message')
  })
})

// ── closeSlaOnHumanReply ─────────────────────────────────────────────────────

describe('closeSlaOnHumanReply', () => {
  it('marks sla_met=true when the human beat the deadline, and closes the task', async () => {
    const supa = createMockSupabase({
      message_response_slas: [
        {
          id: 'sla-1',
          conversation_id: CONVO_ID,
          status: 'pending',
          deadline_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      human_tasks: [
        {
          id: 'task-1',
          organization_id: ORG_ID,
          dedupe_key: `inbound:${CONVO_ID}`,
          status: 'open',
          claimed_by: null,
        },
      ],
    })

    await closeSlaOnHumanReply(supa.client, CONVO_ID, 'user-9')

    const row = supa.table('message_response_slas')[0]
    expect(row.status).toBe('human_responded')
    expect(row.responder_type).toBe('human')
    expect(row.sla_met).toBe(true)
    expect(row.first_response_at).toBeTruthy()

    const task = supa.table('human_tasks')[0]
    expect(task.status).toBe('done')
    expect(task.claimed_by).toBe('user-9')
  })

  it('marks sla_met=false when the human replied after the deadline', async () => {
    const supa = createMockSupabase({
      message_response_slas: [
        {
          id: 'sla-1',
          conversation_id: CONVO_ID,
          status: 'pending',
          deadline_at: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    })

    await closeSlaOnHumanReply(supa.client, CONVO_ID, 'user-9')

    const row = supa.table('message_response_slas')[0]
    expect(row.status).toBe('human_responded')
    expect(row.sla_met).toBe(false)
  })

  it('is a safe no-op on a conversation with no pending timer', async () => {
    const supa = createMockSupabase()
    await expect(
      closeSlaOnHumanReply(supa.client, CONVO_ID, 'user-9')
    ).resolves.toBeUndefined()
  })
})

// ── recordImmediateAiResponse ────────────────────────────────────────────────

describe('recordImmediateAiResponse', () => {
  it('stamps a terminal ai_immediate metrics row (sla_met=true)', async () => {
    const supa = createMockSupabase()

    await recordImmediateAiResponse(supa.client, {
      organizationId: ORG_ID,
      conversationId: CONVO_ID,
      leadId: LEAD_ID,
      inboundMessageId: 'msg-1',
    })

    const row = supa.table('message_response_slas')[0]
    expect(row.status).toBe('ai_immediate')
    expect(row.responder_type).toBe('ai')
    expect(row.sla_met).toBe(true)
    expect(row.first_response_at).toBeTruthy()
  })
})

// ── attemptTakeover ──────────────────────────────────────────────────────────

describe('attemptTakeover', () => {
  it('human race: a staff reply since inbound closes as human_responded without calling the AI', async () => {
    const row = slaRow()
    const replyAt = new Date(Date.now() - 60_000).toISOString() // after deadline
    const supa = createMockSupabase({
      message_response_slas: [row as unknown as Row],
      messages: [
        {
          id: 'msg-out',
          conversation_id: CONVO_ID,
          direction: 'outbound',
          sender_type: 'user',
          created_at: replyAt,
        },
      ],
      human_tasks: [
        {
          id: 'task-1',
          organization_id: ORG_ID,
          dedupe_key: `inbound:${CONVO_ID}`,
          status: 'open',
          claimed_by: null,
        },
      ],
    })

    const outcome = await attemptTakeover(supa.client, row)

    expect(outcome).toBe('human_responded')
    expect(processAutoResponseMock).not.toHaveBeenCalled()

    const stored = supa.table('message_response_slas')[0]
    expect(stored.status).toBe('human_responded')
    expect(stored.responder_type).toBe('human')
    expect(stored.first_response_at).toBe(replyAt)
    expect(stored.sla_met).toBe(false) // replied, but after the deadline

    expect(supa.table('human_tasks')[0].status).toBe('done')
  })

  it('no human reply: AI takes over, task closes as taken_by_ai, sla_met=false', async () => {
    const row = slaRow()
    const supa = createMockSupabase({
      message_response_slas: [row as unknown as Row],
      leads: [{ id: LEAD_ID, organization_id: ORG_ID }],
      conversations: [{ id: CONVO_ID, ai_enabled: true }],
      human_tasks: [
        {
          id: 'task-1',
          organization_id: ORG_ID,
          dedupe_key: `inbound:${CONVO_ID}`,
          status: 'open',
          claimed_by: null,
        },
      ],
    })
    processAutoResponseMock.mockResolvedValue({ action: 'sent', message: 'On it!' })

    const outcome = await attemptTakeover(supa.client, row)

    expect(outcome).toBe('taken_over')
    // The engine was re-run in takeover mode with the stored payload.
    expect(processAutoResponseMock).toHaveBeenCalledWith(
      supa.client,
      expect.objectContaining({
        organization_id: ORG_ID,
        conversation_id: CONVO_ID,
        lead_id: LEAD_ID,
        inbound_message: 'Is Saturday available?',
        channel: 'sms',
        sender_contact: '+15555550100',
      }),
      { takeover: true }
    )

    const stored = supa.table('message_response_slas')[0]
    expect(stored.status).toBe('ai_takeover')
    expect(stored.responder_type).toBe('ai')
    expect(stored.sla_met).toBe(false) // the human window elapsed unanswered
    expect(stored.first_response_at).toBeTruthy()

    expect(supa.table('human_tasks')[0].status).toBe('taken_by_ai')
  })

  it('gate block: a non-sent result expires the row and raises an sla_breach_review task', async () => {
    const row = slaRow()
    const supa = createMockSupabase({
      message_response_slas: [row as unknown as Row],
      leads: [{ id: LEAD_ID, organization_id: ORG_ID }],
      conversations: [{ id: CONVO_ID, ai_enabled: true }],
    })
    processAutoResponseMock.mockResolvedValue({
      action: 'escalated',
      reason: 'medical_question_detected',
    })

    const outcome = await attemptTakeover(supa.client, row)

    expect(outcome).toBe('expired')
    const stored = supa.table('message_response_slas')[0]
    expect(stored.status).toBe('expired')
    expect(stored.takeover_error).toContain('takeover_blocked: escalated')
    expect(stored.takeover_error).toContain('medical_question_detected')

    const breach = supa
      .table('human_tasks')
      .find((t) => t.kind === 'sla_breach_review')
    expect(breach).toBeTruthy()
    expect(breach!.conversation_id).toBe(CONVO_ID)
    expect(breach!.dedupe_key).toBe(`sla_breach:${CONVO_ID}`)
  })

  it('incomplete payload expires the row instead of calling the AI', async () => {
    const row = slaRow({ takeover_payload: {} as unknown as TakeoverPayload })
    const supa = createMockSupabase({
      message_response_slas: [row as unknown as Row],
    })

    const outcome = await attemptTakeover(supa.client, row)

    expect(outcome).toBe('expired')
    expect(processAutoResponseMock).not.toHaveBeenCalled()
    const stored = supa.table('message_response_slas')[0]
    expect(stored.status).toBe('expired')
    expect(stored.takeover_error).toBe('takeover_payload_incomplete')
  })
})
