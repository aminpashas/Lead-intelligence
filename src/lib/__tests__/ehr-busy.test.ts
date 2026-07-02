import { describe, it, expect } from 'vitest'
import { fetchEhrBusyAsAppointments } from '@/lib/booking/ehr-busy'

// Stub whose terminal builder resolves to { data: rows }.
function supa(rows: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {
    select: () => b,
    eq: () => b,
    gte: () => b,
    lte: () => b,
    then: (onF: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(onF),
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: () => b } as any
}

describe('fetchEhrBusyAsAppointments', () => {
  it('maps active busy slots to ExistingAppointment with computed duration', async () => {
    const rows = [
      { starts_at: '2030-01-01T10:00:00Z', ends_at: '2030-01-01T10:30:00Z', status: 'scheduled' },
      { starts_at: '2030-01-01T11:00:00Z', ends_at: '2030-01-01T12:00:00Z', status: 'confirmed' },
    ]
    const out = await fetchEhrBusyAsAppointments(supa(rows), 'org1', 30)
    expect(out).toEqual([
      { scheduled_at: '2030-01-01T10:00:00Z', duration_minutes: 30, status: 'scheduled' },
      { scheduled_at: '2030-01-01T11:00:00Z', duration_minutes: 60, status: 'scheduled' },
    ])
  })

  it('excludes cancelled / canceled / no_show slots (they free the chair)', async () => {
    const rows = [
      { starts_at: '2030-01-01T10:00:00Z', ends_at: '2030-01-01T10:30:00Z', status: 'cancelled' },
      { starts_at: '2030-01-01T11:00:00Z', ends_at: '2030-01-01T11:30:00Z', status: 'no_show' },
      { starts_at: '2030-01-01T12:00:00Z', ends_at: '2030-01-01T12:30:00Z', status: 'canceled' },
      { starts_at: '2030-01-01T13:00:00Z', ends_at: '2030-01-01T13:30:00Z', status: 'scheduled' },
    ]
    const out = await fetchEhrBusyAsAppointments(supa(rows), 'org1', 30)
    expect(out).toHaveLength(1)
    expect(out[0].scheduled_at).toBe('2030-01-01T13:00:00Z')
  })

  it('falls back to 60 min when the end time is missing/invalid', async () => {
    const rows = [{ starts_at: '2030-01-01T10:00:00Z', ends_at: 'not-a-date', status: null }]
    const out = await fetchEhrBusyAsAppointments(supa(rows), 'org1', 30)
    expect(out[0].duration_minutes).toBe(60)
  })

  it('returns [] when there is no data', async () => {
    const out = await fetchEhrBusyAsAppointments(supa(null), 'org1', 30)
    expect(out).toEqual([])
  })
})
