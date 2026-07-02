import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/ehr/carestack/scheduler', () => ({
  getCsLocations: vi.fn(async () => [{ id: 10, name: 'Main' }]),
  getCsProviders: vi.fn(async () => [{ id: 20, firstName: 'Doc' }]),
  searchCsPatients: vi.fn(async () => []),
  createCsPatient: vi.fn(async () => ({ id: 500 })),
  createCsAppointment: vi.fn(async () => ({ appointmentId: 9001 })),
  cancelCsAppointment: vi.fn(async () => ({})),
}))
vi.mock('@/lib/ehr/carestack/match', () => ({
  upsertCareStackPatient: vi.fn(async () => ({ patientRowId: 'p', leadId: 'lead1', matchMethod: 'email_hash', matchConfidence: 1, isNew: false })),
}))

import {
  ensureCareStackPatient,
  pushAppointmentToCareStack,
  cancelAppointmentInCareStack,
} from '@/lib/ehr/carestack/appointments'
import {
  getCsLocations,
  getCsProviders,
  searchCsPatients,
  createCsPatient,
  createCsAppointment,
  cancelCsAppointment,
} from '@/lib/ehr/carestack/scheduler'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CONFIG: any = { base_url: 'https://pmsglobal.carestack.com', identity_url: 'https://id.carestack.com' }
const LEAD = { id: 'lead1', first_name: 'Sam', last_name: 'Lee', email: 'sam@x.com', phone_formatted: '+13105551234', date_of_birth: '1985-06-15' }

// Supabase stub whose patients.maybeSingle() returns `mapped`.
function supa(mapped: unknown) {
  const from = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: () => b,
      eq: () => b,
      limit: () => b,
      maybeSingle: async () => ({ data: mapped ?? null, error: null }),
      single: async () => ({ data: null, error: null }),
    }
    return b
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from } as any
}

describe('CareStack appointment adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCsLocations).mockResolvedValue([{ id: 10, name: 'Main' }])
    vi.mocked(getCsProviders).mockResolvedValue([{ id: 20, firstName: 'Doc' }])
    vi.mocked(searchCsPatients).mockResolvedValue([])
    vi.mocked(createCsPatient).mockResolvedValue({ id: 500 })
    vi.mocked(createCsAppointment).mockResolvedValue({
      id: 9001, patientId: '500', locationId: '10', providerIds: ['20'], startDateTime: '', duration: 60,
    })
  })

  it('ensureCareStackPatient reuses an existing lead→patient mapping', async () => {
    const res = await ensureCareStackPatient(supa({ ehr_patient_id: 'cs-777' }), CONFIG, 'org1', LEAD, 1)
    expect(res).toEqual({ patientId: 'cs-777', isNew: false })
    expect(searchCsPatients).not.toHaveBeenCalled()
    expect(createCsPatient).not.toHaveBeenCalled()
  })

  it('ensureCareStackPatient reuses an email-search hit without creating', async () => {
    vi.mocked(searchCsPatients).mockResolvedValueOnce([{ id: 888 }])
    const res = await ensureCareStackPatient(supa(null), CONFIG, 'org1', LEAD, 1)
    expect(res).toEqual({ patientId: '888', isNew: false })
    expect(createCsPatient).not.toHaveBeenCalled()
  })

  it('ensureCareStackPatient creates a patient when none is found', async () => {
    const res = await ensureCareStackPatient(supa(null), CONFIG, 'org1', LEAD, 1)
    expect(res).toEqual({ patientId: '500', isNew: true })
    expect(createCsPatient).toHaveBeenCalledWith(
      CONFIG,
      expect.objectContaining({ firstName: 'Sam', dob: '1985-06-15', gender: 4, defaultLocationId: 1, email: 'sam@x.com', mobile: '+13105551234' }),
    )
  })

  it('pushAppointmentToCareStack builds the CsAppointment body and returns the id', async () => {
    const appointment = { id: 'ap1', organization_id: 'org1', lead_id: 'lead1', scheduled_at: '2026-07-10T15:00:00Z', duration_minutes: 60 }
    const id = await pushAppointmentToCareStack(supa(null), CONFIG, { appointment, lead: LEAD, settings: {} })
    expect(id).toBe('9001')
    expect(createCsAppointment).toHaveBeenCalledTimes(1)
    const body = vi.mocked(createCsAppointment).mock.calls[0][1]
    expect(body).toMatchObject({
      patientId: '500',
      locationId: '10', // fallback to first location
      providerIds: ['20'], // fallback to first provider, as an array
      duration: 60,
      startDateTime: '2026-07-10T15:00:00.000Z',
    })
  })

  it('pushAppointmentToCareStack prefers configured location/provider over API defaults', async () => {
    const appointment = { id: 'ap1', organization_id: 'org1', lead_id: 'lead1', scheduled_at: '2026-07-10T15:00:00Z', duration_minutes: 30 }
    await pushAppointmentToCareStack(supa(null), CONFIG, {
      appointment,
      lead: LEAD,
      settings: { carestack_location_id: 'L9', carestack_provider_id: 'P9', carestack_appointment_type: 'New Patient Exam' },
    })
    expect(getCsLocations).not.toHaveBeenCalled()
    expect(getCsProviders).not.toHaveBeenCalled()
    const body = vi.mocked(createCsAppointment).mock.calls[0][1]
    expect(body).toMatchObject({ locationId: 'L9', providerIds: ['P9'], productionTypeId: 'New Patient Exam', duration: 30 })
  })

  it('cancelAppointmentInCareStack calls the cancel endpoint', async () => {
    await cancelAppointmentInCareStack(CONFIG, 'cs-42')
    expect(cancelCsAppointment).toHaveBeenCalledWith(CONFIG, 'cs-42')
  })
})
