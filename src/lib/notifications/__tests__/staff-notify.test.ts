import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// ── Module mocks (side-effectful channels only — the Supabase data layer is
//    an in-memory store below, same style as automation/__tests__/tasks.test.ts) ──

vi.mock('@/lib/connectors/dispatcher', () => ({
  dispatchConnectorEvent: vi.fn(async () => {}),
}))
vi.mock('@/lib/messaging/twilio', () => ({
  sendSMS: vi.fn(async () => {}),
}))
vi.mock('@/lib/encryption', () => ({
  decryptField: vi.fn((v: string | null) => v),
}))
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async () => {}),
  },
}))

import {
  notifyInboundMessage,
  notifyHumanTask,
  resolveStaffRecipients,
  NOTIFY_COOLDOWN_MS,
} from '@/lib/notifications/staff-notify'
import { sendPushToUser } from '@/lib/notifications/web-push'
import { dispatchConnectorEvent } from '@/lib/connectors/dispatcher'
import { sendSMS } from '@/lib/messaging/twilio'
import webpush from 'web-push'

const ORG_ID = 'org-1'
const CONVO_ID = 'convo-1'
const LEAD_ID = 'lead-1'

// ── Supabase mock ────────────────────────────────────────────────────────────
// Chainable, thenable query stubs over per-table in-memory row stores.
// Supports the filters staff-notify + resolveAssignee + web-push use:
// eq / in / gte / limit / maybeSingle / single, plus insert/update/delete
// that mutate the store (and are recorded for assertions).

type Row = Record<string, unknown>

function createMockSupabase(seed: Partial<Record<string, Row[]>> = {}) {
  const tables: Record<string, Row[]> = {
    leads: [],
    user_profiles: [],
    conversation_viewers: [],
    notification_log: [],
    push_subscriptions: [],
    ...Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, [...(v ?? [])]])),
  }
  const inserts: Record<string, Row[]> = {}
  const deletes: Record<string, Row[]> = {}

  function makeChain(table: string) {
    const state: {
      op: 'select' | 'insert' | 'update' | 'delete'
      payload?: Row | Row[]
      eqs: Array<[string, unknown]>
      ins: Array<[string, unknown[]]>
      gtes: Array<[string, string]>
    } = { op: 'select', eqs: [], ins: [], gtes: [] }

    const matches = (row: Row) =>
      state.eqs.every(([col, val]) => row[col] === val) &&
      state.ins.every(([col, vals]) => vals.includes(row[col])) &&
      // ISO timestamps compare correctly as strings.
      state.gtes.every(([col, val]) => typeof row[col] === 'string' && (row[col] as string) >= val)

    const run = (): { data: unknown; error: null } => {
      const rows = tables[table] ?? (tables[table] = [])
      if (state.op === 'insert') {
        let newRows = Array.isArray(state.payload) ? state.payload : [state.payload!]
        // Mirror the schema default: notification_log.sent_at defaults to now().
        if (table === 'notification_log') {
          newRows = newRows.map((r) => ({ sent_at: new Date().toISOString(), ...r }))
        }
        rows.push(...newRows)
        ;(inserts[table] ??= []).push(...newRows)
        return { data: newRows, error: null }
      }
      if (state.op === 'update') {
        const hit = rows.filter(matches)
        hit.forEach((r) => Object.assign(r, state.payload))
        return { data: hit, error: null }
      }
      if (state.op === 'delete') {
        const hit = rows.filter(matches)
        ;(deletes[table] ??= []).push(...hit)
        tables[table] = rows.filter((r) => !hit.includes(r))
        return { data: hit, error: null }
      }
      return { data: rows.filter(matches), error: null }
    }

    const chain: Record<string, unknown> = {
      select: vi.fn(() => chain),
      insert: vi.fn((payload: Row | Row[]) => {
        state.op = 'insert'
        state.payload = payload
        return chain
      }),
      update: vi.fn((payload: Row) => {
        state.op = 'update'
        state.payload = payload
        return chain
      }),
      delete: vi.fn(() => {
        state.op = 'delete'
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
      gte: vi.fn((col: string, val: string) => {
        state.gtes.push([col, val])
        return chain
      }),
      limit: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => {
        const r = run()
        const rows = (r.data as Row[]) ?? []
        return { data: rows[0] ?? null, error: null }
      }),
      single: vi.fn(async () => {
        const r = run()
        const rows = (r.data as Row[]) ?? []
        return { data: rows[0] ?? null, error: null }
      }),
      then: (resolve: (v: unknown) => void) => resolve(run()),
    }
    return chain
  }

  return {
    client: { from: vi.fn((table: string) => makeChain(table)) } as unknown as SupabaseClient,
    tables,
    inserts,
    deletes,
  }
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

const profile = (id: string, role: string, overrides: Row = {}): Row => ({
  id,
  organization_id: ORG_ID,
  role,
  is_active: true,
  full_name: `User ${id}`,
  phone: `+1555000${id.length}`,
  email: `${id}@example.com`,
  notification_prefs: {},
  ...overrides,
})

const leadRow = (overrides: Row = {}): Row => ({
  id: LEAD_ID,
  organization_id: ORG_ID,
  assigned_to: null,
  first_name: 'Jane',
  last_name: 'Doe',
  ...overrides,
})

const pushSub = (userId: string, id = `sub-${userId}`): Row => ({
  id,
  user_id: userId,
  endpoint: `https://push.example.com/${id}`,
  keys: { p256dh: 'p', auth: 'a' },
})

const baseInput = {
  organizationId: ORG_ID,
  conversationId: CONVO_ID,
  leadId: LEAD_ID,
  messagePreview: 'Hi, can I reschedule my consult?',
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

beforeEach(() => {
  vi.clearAllMocks()
  process.env.VAPID_PUBLIC_KEY = 'test-public-key'
  process.env.VAPID_PRIVATE_KEY = 'test-private-key'
})

// ── Recipient chain ──────────────────────────────────────────────────────────

describe('resolveStaffRecipients', () => {
  it('prefers the lead assignee when active', async () => {
    const supa = createMockSupabase({
      leads: [leadRow({ assigned_to: 'user-1' })],
      user_profiles: [profile('user-1', 'treatment_coordinator'), profile('admin-1', 'admin')],
    })

    const recipients = await resolveStaffRecipients(supa.client, ORG_ID, LEAD_ID)
    expect(recipients.map((r) => r.id)).toEqual(['user-1'])
    // Full profile rows come back for channel delivery.
    expect(recipients[0].phone).toBeTruthy()
    expect(recipients[0].email).toBe('user-1@example.com')
  })

  it('falls back to the requested role pool when there is no assignee', async () => {
    const supa = createMockSupabase({
      leads: [leadRow()],
      user_profiles: [
        profile('tc-1', 'treatment_coordinator'),
        profile('tc-2', 'treatment_coordinator'),
        profile('admin-1', 'admin'),
      ],
    })

    const recipients = await resolveStaffRecipients(
      supa.client,
      ORG_ID,
      LEAD_ID,
      'treatment_coordinator'
    )
    expect(recipients.map((r) => r.id).sort()).toEqual(['tc-1', 'tc-2'])
  })

  it('falls back to org admins when there is no assignee and no role pool', async () => {
    const supa = createMockSupabase({
      leads: [leadRow()],
      user_profiles: [profile('admin-1', 'admin'), profile('tc-1', 'treatment_coordinator')],
    })

    const recipients = await resolveStaffRecipients(supa.client, ORG_ID, LEAD_ID)
    expect(recipients.map((r) => r.id)).toEqual(['admin-1'])
  })

  it('drops recipients whose profile is inactive', async () => {
    const supa = createMockSupabase({
      leads: [leadRow()],
      user_profiles: [
        // Passes resolveAssignee's admin query only when active; belt-and-braces
        // filter in resolveStaffRecipients also drops explicit is_active=false.
        profile('admin-1', 'admin'),
        profile('admin-2', 'admin', { is_active: false }),
      ],
    })

    const recipients = await resolveStaffRecipients(supa.client, ORG_ID, LEAD_ID)
    expect(recipients.map((r) => r.id)).toEqual(['admin-1'])
  })
})

// ── notifyInboundMessage ─────────────────────────────────────────────────────

describe('notifyInboundMessage', () => {
  it('sends slack + push + sms and logs every send', async () => {
    const supa = createMockSupabase({
      leads: [leadRow({ assigned_to: 'user-1' })],
      user_profiles: [profile('user-1', 'treatment_coordinator')],
      push_subscriptions: [pushSub('user-1')],
    })

    const result = await notifyInboundMessage(supa.client, baseInput)

    expect(result.slackDispatched).toBe(true)
    expect(dispatchConnectorEvent).toHaveBeenCalledTimes(1)
    // Slack goes through the connector dispatcher scoped to slack only.
    const [, event, opts] = vi.mocked(dispatchConnectorEvent).mock.calls[0]
    expect(event.type).toBe('message.received')
    expect(opts).toEqual({ only: ['slack'] })

    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1)
    expect(result.sent).toEqual(
      expect.arrayContaining([
        { userId: 'user-1', channel: 'push' },
        { userId: 'user-1', channel: 'sms' },
      ])
    )

    // Ledger rows: slack (user_id null) + push + sms for user-1.
    const logged = supa.inserts.notification_log ?? []
    expect(logged).toHaveLength(3)
    expect(logged.map((r) => [r.user_id, r.channel]).sort()).toEqual(
      [
        [null, 'slack'],
        ['user-1', 'push'],
        ['user-1', 'sms'],
      ].sort()
    )
    expect(logged.every((r) => r.conversation_id === CONVO_ID)).toBe(true)
  })

  it('suppresses per-user channels for recipients actively viewing the thread', async () => {
    const supa = createMockSupabase({
      leads: [leadRow({ assigned_to: 'user-1' })],
      user_profiles: [profile('user-1', 'treatment_coordinator')],
      push_subscriptions: [pushSub('user-1')],
      conversation_viewers: [
        { conversation_id: CONVO_ID, user_id: 'user-1', last_seen_at: iso(5_000) },
      ],
    })

    const result = await notifyInboundMessage(supa.client, baseInput)

    expect(result.suppressedViewing).toEqual(['user-1'])
    expect(result.sent).toEqual([])
    expect(sendSMS).not.toHaveBeenCalled()
    expect(webpush.sendNotification).not.toHaveBeenCalled()
    // Slack is a shared org channel — presence does not suppress it.
    expect(result.slackDispatched).toBe(true)
  })

  it('dedupes a burst: a second message inside the cooldown sends nothing new', async () => {
    const supa = createMockSupabase({
      leads: [leadRow({ assigned_to: 'user-1' })],
      user_profiles: [profile('user-1', 'treatment_coordinator')],
      push_subscriptions: [pushSub('user-1')],
    })

    const first = await notifyInboundMessage(supa.client, baseInput)
    expect(first.sent).toHaveLength(2)

    // Burst: second inbound moments later, user has NOT viewed the thread.
    const second = await notifyInboundMessage(supa.client, {
      ...baseInput,
      messagePreview: 'Also, is parking validated?',
    })

    expect(second.sent).toEqual([])
    expect(second.slackDispatched).toBe(false)
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1)
    expect(dispatchConnectorEvent).toHaveBeenCalledTimes(1)
    expect(supa.inserts.notification_log).toHaveLength(3) // only the first burst
  })

  it('pings again inside the cooldown once the user has viewed the conversation', async () => {
    const supa = createMockSupabase({
      leads: [leadRow({ assigned_to: 'user-1' })],
      user_profiles: [profile('user-1', 'treatment_coordinator')],
      push_subscriptions: [pushSub('user-1')],
      // Last notified 5 minutes ago (inside the 10-min cooldown)…
      notification_log: [
        {
          organization_id: ORG_ID,
          conversation_id: CONVO_ID,
          user_id: 'user-1',
          channel: 'sms',
          sent_at: iso(5 * 60 * 1000),
        },
      ],
      // …but the user opened the thread 2 minutes ago (after the send, and
      // long enough ago to not count as currently viewing).
      conversation_viewers: [
        { conversation_id: CONVO_ID, user_id: 'user-1', last_seen_at: iso(2 * 60 * 1000) },
      ],
    })

    const result = await notifyInboundMessage(supa.client, { ...baseInput, channels: ['sms'] })

    expect(result.sent).toEqual([{ userId: 'user-1', channel: 'sms' }])
    expect(sendSMS).toHaveBeenCalledTimes(1)
  })

  it('re-notifies after the cooldown window has fully elapsed', async () => {
    const supa = createMockSupabase({
      leads: [leadRow({ assigned_to: 'user-1' })],
      user_profiles: [profile('user-1', 'treatment_coordinator')],
      notification_log: [
        {
          organization_id: ORG_ID,
          conversation_id: CONVO_ID,
          user_id: 'user-1',
          channel: 'sms',
          sent_at: iso(NOTIFY_COOLDOWN_MS + 60_000), // outside the window
        },
      ],
    })

    const result = await notifyInboundMessage(supa.client, { ...baseInput, channels: ['sms'] })
    expect(result.sent).toEqual([{ userId: 'user-1', channel: 'sms' }])
  })

  it('respects per-user channel prefs (explicit false opts out; default is on)', async () => {
    const supa = createMockSupabase({
      leads: [leadRow()],
      user_profiles: [
        profile('admin-1', 'admin', { notification_prefs: { sms: false } }),
        profile('admin-2', 'admin', { notification_prefs: { push: false } }),
      ],
      push_subscriptions: [pushSub('admin-1'), pushSub('admin-2')],
    })

    const result = await notifyInboundMessage(supa.client, baseInput)

    // admin-1: push only (sms opted out); admin-2: sms only (push opted out).
    expect(result.sent).toEqual(
      expect.arrayContaining([
        { userId: 'admin-1', channel: 'push' },
        { userId: 'admin-2', channel: 'sms' },
      ])
    )
    expect(result.sent).toHaveLength(2)
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1)
  })

  it('never throws when the data layer explodes', async () => {
    const broken = {
      from: () => {
        throw new Error('db down')
      },
    } as unknown as SupabaseClient

    const result = await notifyInboundMessage(broken, baseInput)
    expect(result).toEqual({ sent: [], slackDispatched: false, suppressedViewing: [] })
  })
})

// ── Web push pruning ─────────────────────────────────────────────────────────

describe('sendPushToUser', () => {
  it('prunes a subscription when the push service returns 410 Gone', async () => {
    const supa = createMockSupabase({
      push_subscriptions: [pushSub('user-1', 'sub-dead'), pushSub('user-1', 'sub-live')],
    })
    vi.mocked(webpush.sendNotification)
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }))
      .mockResolvedValueOnce(undefined as never)

    const delivered = await sendPushToUser(supa.client, 'user-1', {
      title: 'Test',
      body: 'body',
    })

    expect(delivered).toBe(1)
    // The dead subscription row was deleted; the live one survives.
    expect((supa.deletes.push_subscriptions ?? []).map((r) => r.id)).toEqual(['sub-dead'])
    expect(supa.tables.push_subscriptions.map((r) => r.id)).toEqual(['sub-live'])
    expect(supa.tables.push_subscriptions[0].last_success_at).toBeTruthy()
  })

  it('no-ops when VAPID keys are not configured', async () => {
    delete process.env.VAPID_PUBLIC_KEY
    delete process.env.VAPID_PRIVATE_KEY
    const supa = createMockSupabase({ push_subscriptions: [pushSub('user-1')] })

    const delivered = await sendPushToUser(supa.client, 'user-1', { title: 't', body: 'b' })
    expect(delivered).toBe(0)
    expect(webpush.sendNotification).not.toHaveBeenCalled()
  })
})

// ── notifyHumanTask (lead-keyed, no conversation) ────────────────────────────

describe('notifyHumanTask', () => {
  const taskInput = {
    organizationId: ORG_ID,
    leadId: LEAD_ID,
    title: 'First touch: Jane',
    preview: 'New lead — reach out before the AI takes over.',
    taskId: 'task-1',
  }

  it('pings the lead owner on push + sms and logs lead-keyed (no slack, no conversation)', async () => {
    const supa = createMockSupabase({
      leads: [leadRow({ assigned_to: 'user-1' })],
      user_profiles: [profile('user-1', 'treatment_coordinator')],
      push_subscriptions: [pushSub('user-1')],
    })

    const result = await notifyHumanTask(supa.client, taskInput)

    expect(result.sent).toEqual(
      expect.arrayContaining([
        { userId: 'user-1', channel: 'push' },
        { userId: 'user-1', channel: 'sms' },
      ])
    )
    // First touch has no conversation → org Slack is not this module's job.
    expect(result.slackDispatched).toBe(false)
    expect(dispatchConnectorEvent).not.toHaveBeenCalled()
    expect(sendSMS).toHaveBeenCalledTimes(1)
    // SMS deep-links to the LEAD, not a conversation.
    expect(vi.mocked(sendSMS).mock.calls[0][1]).toContain(`/leads/${LEAD_ID}`)

    const logged = supa.inserts.notification_log ?? []
    expect(logged.map((r) => [r.user_id, r.channel]).sort()).toEqual(
      [
        ['user-1', 'push'],
        ['user-1', 'sms'],
      ].sort()
    )
    // Lead-keyed ledger rows: task.assigned event, no conversation_id.
    expect(logged.every((r) => r.event_type === 'task.assigned')).toBe(true)
    expect(logged.every((r) => r.conversation_id === undefined)).toBe(true)
    expect(logged.every((r) => r.lead_id === LEAD_ID)).toBe(true)
  })

  it('routes to the role pool when no user owns the lead', async () => {
    const supa = createMockSupabase({
      leads: [leadRow({ assigned_to: null })],
      user_profiles: [
        profile('tc-1', 'treatment_coordinator'),
        profile('tc-2', 'treatment_coordinator'),
      ],
      push_subscriptions: [pushSub('tc-1'), pushSub('tc-2')],
    })

    const result = await notifyHumanTask(supa.client, {
      ...taskInput,
      assignedRole: 'treatment_coordinator',
    })

    expect(result.sent.map((s) => s.userId).sort()).toEqual(['tc-1', 'tc-1', 'tc-2', 'tc-2'].sort())
    expect(sendSMS).toHaveBeenCalledTimes(2)
  })

  it('no-ops (no throw) when no recipient resolves', async () => {
    const supa = createMockSupabase({
      leads: [leadRow({ assigned_to: null })],
      user_profiles: [], // no owner, no role pool, no admins
    })

    const result = await notifyHumanTask(supa.client, taskInput)

    expect(result.sent).toEqual([])
    expect(sendSMS).not.toHaveBeenCalled()
    expect(webpush.sendNotification).not.toHaveBeenCalled()
    expect(supa.inserts.notification_log).toBeUndefined()
  })

  it('dedupes inside the cooldown: a second task ping for the same lead sends nothing new', async () => {
    const supa = createMockSupabase({
      leads: [leadRow({ assigned_to: 'user-1' })],
      user_profiles: [profile('user-1', 'treatment_coordinator')],
      push_subscriptions: [pushSub('user-1')],
    })

    const first = await notifyHumanTask(supa.client, taskInput)
    expect(first.sent).toHaveLength(2)

    const second = await notifyHumanTask(supa.client, taskInput)
    expect(second.sent).toEqual([])
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1)
  })

  it('respects a recipient opting out of a channel', async () => {
    const supa = createMockSupabase({
      leads: [leadRow({ assigned_to: 'user-1' })],
      user_profiles: [
        profile('user-1', 'treatment_coordinator', { notification_prefs: { sms: false } }),
      ],
      push_subscriptions: [pushSub('user-1')],
    })

    const result = await notifyHumanTask(supa.client, taskInput)

    expect(result.sent).toEqual([{ userId: 'user-1', channel: 'push' }])
    expect(sendSMS).not.toHaveBeenCalled()
  })
})
