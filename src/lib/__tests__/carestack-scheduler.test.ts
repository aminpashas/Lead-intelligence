import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  DEFAULT_CARESTACK_BASE_URL,
  DEFAULT_CARESTACK_IDENTITY_URL,
  type CareStackConfig,
} from '@/lib/ehr/carestack/client'
import {
  createCsAppointment,
  cancelCsAppointment,
  getCsOperatories,
  getCsProviders,
  getCsLocations,
  searchCsPatients,
  createCsPatient,
  getCsSyncAppointments,
} from '@/lib/ehr/carestack/scheduler'

describe('CareStack default hosts', () => {
  it('defaults the API host to pmsglobal.carestack.com', () => {
    expect(DEFAULT_CARESTACK_BASE_URL).toBe('https://pmsglobal.carestack.com')
  })

  it('defaults the identity host to id.carestack.com', () => {
    expect(DEFAULT_CARESTACK_IDENTITY_URL).toBe('https://id.carestack.com')
  })
})

const cfg: CareStackConfig = {
  account_id: 'acct',
  client_id: 'cid',
  client_secret: 'sec',
  username: 'vendor',
  password: 'accountkey',
  base_url: 'https://pmsglobal.carestack.com',
  identity_url: 'https://id.carestack.com',
}

// Records every fetch call. Token requests get a fake bearer; API requests get `payload`.
function installFetchMock(payload: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, init })
    if (url.includes('/connect/token')) {
      return new Response(JSON.stringify({ access_token: 't0ken', expires_in: 3600 }), { status: 200 })
    }
    return new Response(JSON.stringify(payload), { status: 200 })
  })
  vi.stubGlobal('fetch', mock)
  return { calls, api: () => calls.find((c) => !c.url.includes('/connect/token'))! }
}

describe('CareStack scheduler API', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('createCsAppointment POSTs /api/v1.0/appointments with the body', async () => {
    const { api } = installFetchMock({ appointmentId: 999 })
    const body = {
      patientId: '5', locationId: '1', providerId: '2',
      scheduledStart: '2026-07-10T15:00:00Z', scheduledEnd: '2026-07-10T16:00:00Z',
      duration: 60, appointmentType: 'consultation', status: 'scheduled' as const, isNewPatient: true,
    }
    const res = await createCsAppointment(cfg, body)
    const call = api()
    expect(call.url).toBe('https://pmsglobal.carestack.com/api/v1.0/appointments')
    expect(call.init?.method).toBe('POST')
    expect(JSON.parse(call.init!.body as string)).toMatchObject({ patientId: '5', duration: 60 })
    expect((res as { appointmentId: number }).appointmentId).toBe(999)
  })

  it('cancelCsAppointment PUTs /api/v1.0/appointments/{id}/cancel', async () => {
    const { api } = installFetchMock({ appointmentId: 999, status: 'cancelled' })
    await cancelCsAppointment(cfg, '999')
    const call = api()
    expect(call.url).toBe('https://pmsglobal.carestack.com/api/v1.0/appointments/999/cancel')
    expect(call.init?.method).toBe('PUT')
  })

  it('getCsOperatories GETs /api/v1.0/operatories', async () => {
    const { api } = installFetchMock([{ id: 1, locationId: 1, name: 'Op 1' }])
    const ops = await getCsOperatories(cfg)
    expect(api().url).toBe('https://pmsglobal.carestack.com/api/v1.0/operatories')
    expect(ops[0].name).toBe('Op 1')
  })

  it('getCsProviders GETs /api/v1.0/providers', async () => {
    const { api } = installFetchMock([{ id: 2, firstName: 'A', lastName: 'B' }])
    await getCsProviders(cfg)
    expect(api().url).toBe('https://pmsglobal.carestack.com/api/v1.0/providers')
  })

  it('getCsLocations GETs /api/v1.0/locations', async () => {
    const { api } = installFetchMock([{ id: 1, name: 'Main' }])
    await getCsLocations(cfg)
    expect(api().url).toBe('https://pmsglobal.carestack.com/api/v1.0/locations')
  })

  it('searchCsPatients POSTs /api/v2.0/patients/search', async () => {
    const { api } = installFetchMock([])
    await searchCsPatients(cfg, { email: 'x@y.com' })
    const call = api()
    expect(call.url).toBe('https://pmsglobal.carestack.com/api/v2.0/patients/search')
    expect(call.init?.method).toBe('POST')
    expect(JSON.parse(call.init!.body as string)).toEqual({ email: 'x@y.com' })
  })

  it('createCsPatient POSTs /api/v1.0/patients', async () => {
    const { api } = installFetchMock({ id: 5 })
    await createCsPatient(cfg, { firstName: 'A', lastName: 'B' })
    const call = api()
    expect(call.url).toBe('https://pmsglobal.carestack.com/api/v1.0/patients')
    expect(call.init?.method).toBe('POST')
  })

  it('getCsSyncAppointments GETs /sync/appointments with modifiedSince', async () => {
    const { api } = installFetchMock({ results: [], continueToken: null })
    await getCsSyncAppointments(cfg, '2026-07-01T00:00:00Z')
    const call = api()
    expect(call.url).toContain('https://pmsglobal.carestack.com/api/v1.0/sync/appointments')
    expect(call.url).toContain('modifiedSince=2026-07-01T00%3A00%3A00Z')
  })
})
