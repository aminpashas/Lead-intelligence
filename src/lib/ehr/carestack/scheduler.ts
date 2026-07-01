/**
 * Typed CareStack scheduler API — thin wrappers over the generic carestackFetch
 * transport. Endpoints proven in the sibling MDRCM client (v1.0.54). No business
 * logic here (patient matching / LI→CareStack mapping / persistence live in the
 * Phase 4 appointments adapter). Ids are treated as strings (never arithmetic).
 */
import { carestackFetch, type CareStackConfig } from './client'

// ── Types (minimal mirror of CareStack shapes we use) ───────────────────────
export type CsAppointmentStatus =
  | 'scheduled' | 'confirmed' | 'arrived' | 'in_chair'
  | 'completed' | 'cancelled' | 'no_show' | 'rescheduled'

export interface CsAppointment {
  appointmentId: string | number
  patientId: string
  locationId: string
  providerId: string
  operatoryId?: string
  scheduledStart: string
  scheduledEnd: string
  duration: number
  appointmentType: string
  cdtCodes?: string[]
  status: CsAppointmentStatus
  notes?: string
  isNewPatient: boolean
}

export interface CsOperatory { id: number; locationId: number; name: string }
export interface CsProvider { id: number; firstName?: string; lastName?: string; fullName?: string }
export interface CsLocation { id: number; name: string; timeZone?: string }
export interface CsPatient { id: number; firstName?: string; lastName?: string; email?: string; mobileNumber?: string }
export interface CsSyncAppointmentsResponse {
  results?: Array<Record<string, unknown>>
  continueToken?: string | null
}

// ── Appointments ────────────────────────────────────────────────────────────
export function getCsAppointment(config: CareStackConfig, appointmentId: string) {
  return carestackFetch<CsAppointment>(config, `/appointments/${appointmentId}`)
}

export function createCsAppointment(config: CareStackConfig, appointment: Partial<CsAppointment>) {
  return carestackFetch<CsAppointment>(config, '/appointments', { method: 'POST', body: appointment })
}

export function cancelCsAppointment(config: CareStackConfig, appointmentId: string) {
  return carestackFetch<CsAppointment>(config, `/appointments/${appointmentId}/cancel`, { method: 'PUT' })
}

// ── Schedule reference data ──────────────────────────────────────────────────
export function getCsOperatories(config: CareStackConfig) {
  return carestackFetch<CsOperatory[]>(config, '/operatories')
}

export function getCsProviders(config: CareStackConfig) {
  return carestackFetch<CsProvider[]>(config, '/providers')
}

export function getCsLocations(config: CareStackConfig) {
  return carestackFetch<CsLocation[]>(config, '/locations')
}

// ── Patients ────────────────────────────────────────────────────────────────
export function searchCsPatients(config: CareStackConfig, searchParams: Record<string, unknown>) {
  // Patient search is on v2.0.
  return carestackFetch<CsPatient[]>(config, '/patients/search', { method: 'POST', body: searchParams, version: 'v2.0' })
}

export function createCsPatient(config: CareStackConfig, patient: Partial<CsPatient>) {
  return carestackFetch<CsPatient>(config, '/patients', { method: 'POST', body: patient })
}

// ── Sync (availability overlay input, Phase 5) ───────────────────────────────
export function getCsSyncAppointments(config: CareStackConfig, modifiedSince: string, continueToken?: string) {
  return carestackFetch<CsSyncAppointmentsResponse>(config, '/sync/appointments', {
    query: { modifiedSince, continueToken: continueToken ?? undefined },
  })
}
