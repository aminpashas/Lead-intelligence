import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the two external legs so we assert what the seam drives, not their internals.
vi.mock('@/lib/bridges/dion-clinical', () => ({
  emitAppointmentBooked: vi.fn(async () => ({ ok: true, status: 200 })),
  emitAppointmentCancelled: vi.fn(async () => ({ ok: true, status: 200 })),
}))
vi.mock('@/lib/connectors', () => ({
  dispatchConnectorEvent: vi.fn(() => Promise.resolve([])),
  buildConnectorLeadData: vi.fn((lead: Record<string, unknown>) => ({ id: lead.id, firstName: lead.first_name })),
}))

import { syncAppointmentToEhr } from '@/lib/booking/ehr-sync'
import { emitAppointmentBooked, emitAppointmentCancelled } from '@/lib/bridges/dion-clinical'
import { dispatchConnectorEvent } from '@/lib/connectors'

type Seed = { appointment?: unknown; organization?: unknown; lead?: unknown }

function makeSupabase(seed: Seed) {
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

const APPT = { id: 'ap1', organization_id: 'org1', lead_id: 'lead1', scheduled_at: '2026-07-10T15:00:00', ehr_sync_attempts: 0 }
const ORG = { dion_practice_id: 'prac1' }
const LEAD = { id: 'lead1', first_name: 'Sam', last_name: 'Lee' }

describe('syncAppointmentToEhr', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(emitAppointmentBooked).mockResolvedValue({ ok: true, status: 200 })
    vi.mocked(emitAppointmentCancelled).mockResolvedValue({ ok: true, status: 200 })
  })

  it('book: emits appointment.booked, marks synced, and notifies Slack', async () => {
    const { client, updates } = makeSupabase({ appointment: APPT, organization: ORG, lead: LEAD })
    await syncAppointmentToEhr(client, 'ap1', { action: 'book' })

    expect(emitAppointmentBooked).toHaveBeenCalledWith({
      appointmentId: 'ap1',
      startsAt: '2026-07-10T15:00:00',
      dionPracticeId: 'prac1',
    })
    const apptUpdate = updates.find((u) => u.table === 'appointments')
    expect(apptUpdate?.vals).toMatchObject({ dion_sync_status: 'synced', ehr_sync_attempts: 1, ehr_sync_error: null })
    expect(dispatchConnectorEvent).toHaveBeenCalledTimes(1)
    expect(vi.mocked(dispatchConnectorEvent).mock.calls[0][1]).toMatchObject({ type: 'consultation.scheduled', leadId: 'lead1' })
  })

  it('cancel: emits appointment.cancelled with reasonCode and does NOT notify Slack', async () => {
    const { client } = makeSupabase({ appointment: APPT, organization: ORG, lead: LEAD })
    await syncAppointmentToEhr(client, 'ap1', { action: 'cancel', reasonCode: 'no-show' })

    expect(emitAppointmentCancelled).toHaveBeenCalledWith({ appointmentId: 'ap1', reasonCode: 'no-show', dionPracticeId: 'prac1' })
    expect(emitAppointmentBooked).not.toHaveBeenCalled()
    expect(dispatchConnectorEvent).not.toHaveBeenCalled()
  })

  it('marks failed + logs an activity when the Dion leg fails', async () => {
    vi.mocked(emitAppointmentBooked).mockResolvedValueOnce({ ok: false, error: 'boom' })
    const { client, updates, inserts } = makeSupabase({ appointment: APPT, organization: ORG, lead: LEAD })
    await syncAppointmentToEhr(client, 'ap1', { action: 'book' })

    expect(updates.find((u) => u.table === 'appointments')?.vals).toMatchObject({ dion_sync_status: 'failed', ehr_sync_error: 'boom' })
    expect(inserts.find((i) => i.table === 'lead_activities')?.vals).toMatchObject({ activity_type: 'ehr_sync_failed' })
  })

  it('marks skipped (no failure log) when the bridge is unconfigured', async () => {
    vi.mocked(emitAppointmentBooked).mockResolvedValueOnce({ ok: true, skipped: true })
    const { client, updates, inserts } = makeSupabase({ appointment: APPT, organization: ORG, lead: LEAD })
    await syncAppointmentToEhr(client, 'ap1', { action: 'book' })

    expect(updates.find((u) => u.table === 'appointments')?.vals).toMatchObject({ dion_sync_status: 'skipped' })
    expect(inserts.find((i) => i.table === 'lead_activities')).toBeUndefined()
  })

  it('is a no-op when the appointment is missing', async () => {
    const { client } = makeSupabase({})
    await syncAppointmentToEhr(client, 'missing', { action: 'book' })
    expect(emitAppointmentBooked).not.toHaveBeenCalled()
  })
})
