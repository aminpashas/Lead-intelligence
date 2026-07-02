import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/ehr/carestack/scheduler', () => ({
  getCsSyncAppointments: vi.fn(),
}))

import { syncCareStackBusySlots } from '@/lib/ehr/carestack/busy-sync'
import { getCsSyncAppointments } from '@/lib/ehr/carestack/scheduler'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CONFIG: any = { base_url: 'https://pmsglobal.carestack.com' }

function supaCapturingUpserts(error: { message: string } | null = null) {
  const upserts: Array<{ rows: unknown; opts: unknown }> = []
  const from = () => ({
    upsert: (rows: unknown, opts: unknown) => {
      upserts.push({ rows, opts })
      return Promise.resolve({ data: null, error })
    },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from } as any, upserts }
}

describe('syncCareStackBusySlots', () => {
  beforeEach(() => vi.clearAllMocks())

  it('maps sync/appointments rows and upserts them idempotently', async () => {
    vi.mocked(getCsSyncAppointments).mockResolvedValueOnce({
      results: [{ id: 1, patientId: 5, startDateTime: '2030-01-01T10:00:00Z', duration: 30, status: 'Confirmed', productionTypeId: 7 }],
      continueToken: null,
    })
    const { client, upserts } = supaCapturingUpserts()
    const run = await syncCareStackBusySlots(client, 'org1', CONFIG)

    expect(run).toMatchObject({ resource: 'busy_slots', fetched: 1, upserted: 1, status: 'ok' })
    expect(upserts).toHaveLength(1)
    expect(upserts[0].opts).toEqual({ onConflict: 'organization_id,ehr_source,ehr_appointment_id' })
    expect((upserts[0].rows as unknown[])[0]).toEqual({
      organization_id: 'org1',
      ehr_source: 'carestack',
      ehr_appointment_id: '1',
      ehr_patient_id: '5',
      starts_at: '2030-01-01T10:00:00.000Z',
      ends_at: '2030-01-01T10:30:00.000Z',
      status: 'confirmed',
      appointment_type: '7',
    })
  })

  it('follows continueToken across pages then stops', async () => {
    vi.mocked(getCsSyncAppointments)
      .mockResolvedValueOnce({ results: [{ id: 1, startDateTime: '2030-01-01T10:00:00Z', duration: 60, status: 'Scheduled' }], continueToken: 'next' })
      .mockResolvedValueOnce({ results: [{ id: 2, startDateTime: '2030-01-02T10:00:00Z', duration: 60, status: 'Scheduled' }], continueToken: null })
    const { client, upserts } = supaCapturingUpserts()
    const run = await syncCareStackBusySlots(client, 'org1', CONFIG)

    expect(getCsSyncAppointments).toHaveBeenCalledTimes(2)
    expect(run.fetched).toBe(2)
    expect(upserts).toHaveLength(2)
  })

  it('skips rows with no valid start time', async () => {
    vi.mocked(getCsSyncAppointments).mockResolvedValueOnce({
      results: [
        { id: 1, startDateTime: 'garbage', duration: 30, status: 'Scheduled' },
        { id: 2, duration: 30, status: 'Scheduled' },
      ],
      continueToken: null,
    })
    const { client, upserts } = supaCapturingUpserts()
    const run = await syncCareStackBusySlots(client, 'org1', CONFIG)
    expect(run.fetched).toBe(2)
    expect(run.upserted).toBe(0)
    expect(upserts).toHaveLength(0)
  })

  it('returns status failed when the upsert errors', async () => {
    vi.mocked(getCsSyncAppointments).mockResolvedValueOnce({
      results: [{ id: 1, startDateTime: '2030-01-01T10:00:00Z', duration: 30, status: 'Scheduled' }],
      continueToken: null,
    })
    const { client } = supaCapturingUpserts({ message: 'db down' })
    const run = await syncCareStackBusySlots(client, 'org1', CONFIG)
    expect(run.status).toBe('failed')
    expect(run.error).toContain('db down')
  })
})
