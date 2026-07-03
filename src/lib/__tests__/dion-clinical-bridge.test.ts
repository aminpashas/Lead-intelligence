import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  emitAppointmentRequested,
  emitAppointmentBooked,
  emitAppointmentCancelled,
  emitCaseTreatmentAgreed,
} from '@/lib/bridges/dion-clinical'
import { dionAppointmentSchema } from '@/lib/bridges/dion/appointment'
import { dionCaseSchema } from '@/lib/bridges/dion/case'

function installFetchMock(status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: typeof input === 'string' ? input : input.toString(), init })
    return new Response(JSON.stringify({ accepted: 'ok' }), { status })
  })
  vi.stubGlobal('fetch', mock)
  return { mock, calls }
}

function configureBridge() {
  vi.stubEnv('DION_CLINICAL_URL', 'https://dion-clinical.example.com')
  vi.stubEnv('DION_BUS_SECRET', 's3cret')
}

function bodyOf(call: { init?: RequestInit }) {
  return JSON.parse(call.init!.body as string)
}

describe('Dion Clinical bridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('emitAppointmentBooked POSTs a valid envelope to /api/bus/receive', async () => {
    configureBridge()
    const { calls } = installFetchMock(200)
    const res = await emitAppointmentBooked({ appointmentId: 'a1', startsAt: '2026-07-10T15:00:00Z' })

    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call.url).toBe('https://dion-clinical.example.com/api/bus/receive')
    expect(call.init?.method).toBe('POST')
    expect((call.init?.headers as Record<string, string>)['x-forward-secret']).toBe('s3cret')

    const body = bodyOf(call)
    expect(body).toMatchObject({
      type: 'appointment.booked',
      source: 'lead-intelligence',
      envelopeVersion: 1,
      dionPracticeId: null,
      data: { appointmentId: 'a1', dionPatientId: null },
    })
    expect(body.data.startsAt).toBe('2026-07-10T15:00:00.000Z')
    expect(body.idempotencyKey).toBe('a1:appointment.booked')
    // The emitted event must pass the vendored contract (== the receiver's).
    expect(dionAppointmentSchema.safeParse(body).success).toBe(true)
  })

  it('emitAppointmentRequested emits the requested type with nullable patient', async () => {
    configureBridge()
    const { calls } = installFetchMock(200)
    await emitAppointmentRequested({ appointmentId: 'a2' })
    const body = bodyOf(calls[0])
    expect(body.type).toBe('appointment.requested')
    expect(body.data).toEqual({ appointmentId: 'a2', dionPatientId: null })
  })

  it('emitAppointmentCancelled includes the reasonCode', async () => {
    configureBridge()
    const { calls } = installFetchMock(200)
    await emitAppointmentCancelled({ appointmentId: 'a3', reasonCode: 'no-show' })
    const body = bodyOf(calls[0])
    expect(body.type).toBe('appointment.cancelled')
    expect(body.data).toEqual({ appointmentId: 'a3', reasonCode: 'no-show' })
  })

  it('passes through a resolved dionPatientId + dionPracticeId', async () => {
    configureBridge()
    const { calls } = installFetchMock(200)
    await emitAppointmentBooked({ appointmentId: 'a4', startsAt: '2026-07-10T15:00:00Z', dionPatientId: 'p9', dionPracticeId: 'prac1' })
    const body = bodyOf(calls[0])
    expect(body.dionPracticeId).toBe('prac1')
    expect(body.data.dionPatientId).toBe('p9')
  })

  it('skips (no fetch) when the bridge is not configured', async () => {
    vi.stubEnv('DION_CLINICAL_URL', '')
    vi.stubEnv('DION_BUS_SECRET', '')
    const { mock } = installFetchMock(200)
    const res = await emitAppointmentBooked({ appointmentId: 'a5', startsAt: '2026-07-10T15:00:00Z' })
    expect(res).toEqual({ ok: true, skipped: true })
    expect(mock).not.toHaveBeenCalled()
  })

  it('returns ok:false on a non-2xx response', async () => {
    configureBridge()
    installFetchMock(500)
    const res = await emitAppointmentBooked({ appointmentId: 'a6', startsAt: '2026-07-10T15:00:00Z' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(500)
  })

  it('returns ok:false on an invalid startsAt without calling fetch', async () => {
    configureBridge()
    const { mock } = installFetchMock(200)
    const res = await emitAppointmentBooked({ appointmentId: 'a7', startsAt: 'not-a-date' })
    expect(res.ok).toBe(false)
    expect(mock).not.toHaveBeenCalled()
  })

  it('uses a deterministic envelope id per (appointmentId, type) so retries dedupe', async () => {
    configureBridge()
    const { calls } = installFetchMock(200)
    await emitAppointmentBooked({ appointmentId: 'a1', startsAt: '2026-07-10T15:00:00Z' })
    await emitAppointmentBooked({ appointmentId: 'a1', startsAt: '2026-07-10T15:00:00Z' })
    await emitAppointmentBooked({ appointmentId: 'a2', startsAt: '2026-07-10T15:00:00Z' })
    const [id1, id2, id3] = calls.map((c) => bodyOf(c).id)
    expect(id1).toBe(id2) // same appointment + type → same id
    expect(id1).not.toBe(id3) // different appointment → different id
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('emitCaseTreatmentAgreed POSTs a valid case.treatment_agreed envelope', async () => {
    configureBridge()
    const { calls } = installFetchMock(200)
    const res = await emitCaseTreatmentAgreed({
      caseId: 'case-1',
      treatmentPlanId: 'plan-1',
      agreementConfirmedAt: '2026-07-02T18:00:00Z',
      estimatedSurgeryDate: '2026-08-15',
      proceduresCdt: ['D6010', 'D6056'],
      dionPracticeId: 'prac1',
    })

    expect(res.ok).toBe(true)
    const body = bodyOf(calls[0])
    expect(body).toMatchObject({
      type: 'case.treatment_agreed',
      source: 'lead-intelligence',
      dionPracticeId: 'prac1',
      idempotencyKey: 'case-1:case.treatment_agreed',
      data: {
        caseId: 'case-1',
        dionPatientId: null,
        treatmentPlanId: 'plan-1',
        agreementConfirmedAt: '2026-07-02T18:00:00.000Z',
        estimatedSurgeryDate: '2026-08-15',
        proceduresCdt: ['D6010', 'D6056'],
      },
    })
    // The emitted event must pass the vendored contract (== the receiver's).
    expect(dionCaseSchema.safeParse(body).success).toBe(true)
  })

  it('emitCaseTreatmentAgreed retries carry the same deterministic envelope id', async () => {
    configureBridge()
    const { calls } = installFetchMock(200)
    const p = { caseId: 'case-2', agreementConfirmedAt: '2026-07-02T18:00:00Z' }
    await emitCaseTreatmentAgreed(p)
    await emitCaseTreatmentAgreed(p)
    const [id1, id2] = calls.map((c) => bodyOf(c).id)
    expect(id1).toBe(id2)
  })

  it('emitCaseTreatmentAgreed rejects an invalid agreementConfirmedAt without fetching', async () => {
    configureBridge()
    const { mock } = installFetchMock(200)
    const res = await emitCaseTreatmentAgreed({ caseId: 'case-3', agreementConfirmedAt: 'not-a-date' })
    expect(res.ok).toBe(false)
    expect(mock).not.toHaveBeenCalled()
  })

  it('vendored schema rejects a malformed event', () => {
    const bad = { type: 'appointment.booked', source: 'lead-intelligence', envelopeVersion: 1, id: 'x', occurredAt: 'x', dionPracticeId: null, data: { dionPatientId: null } }
    expect(dionAppointmentSchema.safeParse(bad).success).toBe(false)
  })
})
