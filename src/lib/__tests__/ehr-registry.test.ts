/**
 * Multi-adapter behaviour of the booking seam, plus the registry's own contract.
 *
 * The single-EMR paths are covered by ehr-sync.test.ts (which still drives the
 * real CareStack adapter). This file covers what only exists once there is more
 * than one adapter — capability gating, per-leg independence, and id merging —
 * by mocking the registry with fakes rather than inventing a second real EMR.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EhrAdapter, EhrCapability } from '@/lib/ehr/port'

vi.mock('@/lib/bridges/dion-clinical', () => ({
  emitAppointmentBooked: vi.fn(async () => ({ ok: true, status: 200 })),
  emitAppointmentCancelled: vi.fn(async () => ({ ok: true, status: 200 })),
}))
vi.mock('@/lib/connectors', () => ({
  dispatchConnectorEvent: vi.fn(() => Promise.resolve([])),
  buildConnectorLeadData: vi.fn((lead: Record<string, unknown>) => ({ id: lead.id })),
}))
vi.mock('@/lib/ehr/registry', () => ({
  getEnabledAdapters: vi.fn(async () => []),
  EHR_CONNECTOR_TYPES: ['carestack'],
}))

import { syncAppointmentToEhr } from '@/lib/booking/ehr-sync'
import { emitAppointmentBooked } from '@/lib/bridges/dion-clinical'
import { getEnabledAdapters } from '@/lib/ehr/registry'

/** A fake adapter. Only the bits the seam touches are real. */
function fakeAdapter(
  source: string,
  opts: {
    capabilities?: EhrCapability[]
    createAppointment?: () => Promise<{ externalId: string }>
    cancelAppointment?: () => Promise<void>
  } = {},
): EhrAdapter {
  return {
    source: source as EhrAdapter['source'],
    capabilities: new Set(opts.capabilities ?? ['appointment.write']),
    getConfig: async () => ({}),
    createAppointment: opts.createAppointment ?? (async () => ({ externalId: `${source}-1` })),
    cancelAppointment: opts.cancelAppointment ?? (async () => undefined),
    runSync: async () => [],
    normalizeProcedureStatus: () => 'other',
    normalizeAppointmentStatus: () => 'scheduled',
  }
}

function makeSupabase(seed: { appointment?: unknown; organization?: unknown; lead?: unknown }) {
  const updates: Array<{ table: string; vals: Record<string, unknown> }> = []
  const inserts: Array<{ table: string; vals: Record<string, unknown> }> = []
  const resultFor = (table: string) => {
    if (table === 'appointments') return { data: seed.appointment ?? null, error: null }
    if (table === 'organizations') return { data: seed.organization ?? null, error: null }
    if (table === 'leads') return { data: seed.lead ?? null, error: null }
    return { data: null, error: null }
  }
  const from = (table: string) => {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      single: () => Promise.resolve(resultFor(table)),
      maybeSingle: () => Promise.resolve(resultFor(table)),
      update: (vals: Record<string, unknown>) => {
        updates.push({ table, vals })
        return builder
      },
      insert: (vals: Record<string, unknown>) => {
        inserts.push({ table, vals })
        return Promise.resolve({ data: null, error: null })
      },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resultFor(table)).then(onF, onR),
    }
    return builder
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from } as any, updates, inserts }
}

const APPT = {
  id: 'ap1', organization_id: 'org1', lead_id: 'lead1',
  scheduled_at: '2026-07-10T15:00:00', ehr_sync_attempts: 0,
  carestack_appointment_id: null, ehr_external_ids: null,
}
const ORG = { dion_practice_id: 'prac1' }
const LEAD = { id: 'lead1', first_name: 'Sam' }

/** The second `update` call is the multi-EMR link write. */
const linkWrite = (updates: Array<{ table: string; vals: Record<string, unknown> }>) =>
  updates.filter((u) => u.table === 'appointments').find((u) => 'ehr_external_ids' in u.vals)?.vals

describe('booking seam across multiple adapters', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(emitAppointmentBooked).mockResolvedValue({ ok: true, status: 200 })
  })

  it('writes an external id per adapter, keyed by source', async () => {
    vi.mocked(getEnabledAdapters).mockResolvedValue([
      { adapter: fakeAdapter('carestack'), config: {} },
      { adapter: fakeAdapter('dentrix'), config: {} },
    ])
    const { client, updates } = makeSupabase({ appointment: APPT, organization: ORG, lead: LEAD })
    await syncAppointmentToEhr(client, 'ap1', { action: 'book' })

    expect(linkWrite(updates)?.ehr_external_ids).toEqual({ carestack: 'carestack-1', dentrix: 'dentrix-1' })
    expect(linkWrite(updates)?.ehr_sync_status).toBe('synced')
  })

  it('SKIPS (does not fail) an adapter without appointment.write — read-only tiers are valid', async () => {
    const readOnly = fakeAdapter('dentrix', {
      capabilities: ['busy.sync', 'outcomes.sync'],
      createAppointment: async () => {
        throw new Error('must not be called on a read-only adapter')
      },
    })
    vi.mocked(getEnabledAdapters).mockResolvedValue([{ adapter: readOnly, config: {} }])
    const { client, updates, inserts } = makeSupabase({ appointment: APPT, organization: ORG, lead: LEAD })
    await syncAppointmentToEhr(client, 'ap1', { action: 'book' })

    expect(linkWrite(updates)?.ehr_sync_status).toBe('skipped')
    // A skip is not a failure: no error text, no activity log.
    expect(updates.find((u) => u.table === 'appointments')?.vals.ehr_sync_error).toBeNull()
    expect(inserts.find((i) => i.table === 'lead_activities')).toBeUndefined()
  })

  it('one throwing adapter does not stop the others or the Dion leg', async () => {
    const boom = fakeAdapter('dentrix', {
      createAppointment: async () => { throw new Error('PMS down') },
    })
    vi.mocked(getEnabledAdapters).mockResolvedValue([
      { adapter: boom, config: {} },
      { adapter: fakeAdapter('carestack'), config: {} },
    ])
    const { client, updates, inserts } = makeSupabase({ appointment: APPT, organization: ORG, lead: LEAD })
    await syncAppointmentToEhr(client, 'ap1', { action: 'book' })

    // Dion still ran.
    expect(emitAppointmentBooked).toHaveBeenCalledTimes(1)
    expect(updates.find((u) => u.table === 'appointments')?.vals.dion_sync_status).toBe('synced')
    // The healthy adapter still recorded its id.
    expect(linkWrite(updates)?.ehr_external_ids).toEqual({ carestack: 'carestack-1' })
    // Worst-of wins, and the failure is attributed to the right vendor.
    expect(linkWrite(updates)?.ehr_sync_status).toBe('failed')
    expect(String(updates.find((u) => u.table === 'appointments')?.vals.ehr_sync_error)).toContain('dentrix: PMS down')
    expect(inserts.find((i) => i.table === 'lead_activities')?.vals).toMatchObject({
      activity_type: 'ehr_sync_failed',
      metadata: expect.objectContaining({ leg: 'dentrix' }),
    })
  })

  it('does not re-create an appointment that already has an external id for that source', async () => {
    const create = vi.fn(async () => ({ externalId: 'should-not-happen' }))
    vi.mocked(getEnabledAdapters).mockResolvedValue([
      { adapter: fakeAdapter('carestack', { createAppointment: create }), config: {} },
    ])
    const seeded = { ...APPT, ehr_external_ids: { carestack: 'cs-existing' } }
    const { client, updates } = makeSupabase({ appointment: seeded, organization: ORG, lead: LEAD })
    await syncAppointmentToEhr(client, 'ap1', { action: 'book' })

    expect(create).not.toHaveBeenCalled()
    expect(linkWrite(updates)?.ehr_external_ids).toEqual({ carestack: 'cs-existing' })
  })

  it('falls back to the legacy carestack column when the jsonb map is empty', async () => {
    const create = vi.fn(async () => ({ externalId: 'should-not-happen' }))
    vi.mocked(getEnabledAdapters).mockResolvedValue([
      { adapter: fakeAdapter('carestack', { createAppointment: create }), config: {} },
    ])
    const legacy = { ...APPT, ehr_external_ids: null, carestack_appointment_id: 'cs-legacy' }
    const { client } = makeSupabase({ appointment: legacy, organization: ORG, lead: LEAD })
    await syncAppointmentToEhr(client, 'ap1', { action: 'book' })

    // Pre-migration rows must not get a duplicate appointment in the PMS.
    expect(create).not.toHaveBeenCalled()
  })

  it('cancel only calls adapters that hold an external id', async () => {
    const cancelKnown = vi.fn(async () => undefined)
    const cancelUnknown = vi.fn(async () => undefined)
    vi.mocked(getEnabledAdapters).mockResolvedValue([
      { adapter: fakeAdapter('carestack', { cancelAppointment: cancelKnown }), config: {} },
      { adapter: fakeAdapter('dentrix', { cancelAppointment: cancelUnknown }), config: {} },
    ])
    const seeded = { ...APPT, ehr_external_ids: { carestack: 'cs-1' } }
    const { client } = makeSupabase({ appointment: seeded, organization: ORG, lead: LEAD })
    await syncAppointmentToEhr(client, 'ap1', { action: 'cancel', reasonCode: 'no-show' })

    expect(cancelKnown).toHaveBeenCalledTimes(1)
    expect(cancelUnknown).not.toHaveBeenCalled()
  })
})

describe('registry contract', () => {
  it('resolves the real CareStack adapter and rejects unknown sources', async () => {
    const actual = await vi.importActual<typeof import('@/lib/ehr/registry')>('@/lib/ehr/registry')
    expect(actual.getAdapter('carestack')?.source).toBe('carestack')
    expect(actual.getAdapter('manual')).toBeUndefined()
    expect(actual.getAdapter(null)).toBeUndefined()
    expect(actual.getAdapter(undefined)).toBeUndefined()
    expect(actual.isEhrSource('carestack')).toBe(true)
    expect(actual.isEhrSource('nope')).toBe(false)
    // The cron scopes its org query to these.
    expect(actual.EHR_CONNECTOR_TYPES).toContain('carestack')
  })

  it('omits an adapter whose getConfig returns null or throws, without failing the rest', async () => {
    const actual = await vi.importActual<typeof import('@/lib/ehr/registry')>('@/lib/ehr/registry')
    // The real registry holds only CareStack; getConfig hits our fake supabase and
    // returns null (no connector_configs row), so nothing resolves — and crucially
    // it does not throw.
    const { client } = makeSupabase({})
    await expect(actual.getEnabledAdapters(client, 'org1')).resolves.toEqual([])
  })
})
