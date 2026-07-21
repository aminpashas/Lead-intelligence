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

/**
 * CareStack appointment RESOURCE (the /appointments create + GET shape).
 *
 * IMPORTANT — the time field name differs by endpoint:
 *   • The appointment resource (POST/GET /appointments) uses `dateTime`.
 *   • The /sync/appointments FEED returns the same value under `startDateTime`.
 * Sending `startDateTime` to the create endpoint is silently ignored — the row
 * is created (201) but its time defaults to 0001-01-01, so it never appears on
 * the schedule. Verified live against the account-10300 API (2026-07-21).
 *
 * The value is a NAIVE, location-local wall-clock string ("YYYY-MM-DDTHH:mm:ss",
 * no `Z`, no offset, no milliseconds) — NOT a UTC ISO string. A `…Z` value also
 * fails to parse and collapses to 0001-01-01.
 *
 * Other field names verified live: providerIds ARRAY (not providerId), numeric
 * productionTypeId (not appointmentType), duration in minutes (no explicit end).
 */
export interface CsAppointment {
  id?: string | number
  patientId: string | number
  locationId: string | number
  providerIds: Array<string | number>
  operatoryId?: string | number
  dateTime: string                 // naive location-local wall clock, YYYY-MM-DDTHH:mm:ss
  duration: number                 // minutes
  productionTypeId?: string | number
  status?: string
  notes?: string
}

export interface CsOperatory { id: number; locationId: number; name: string }
export interface CsProvider { id: number; firstName?: string; lastName?: string; fullName?: string }
export interface CsLocation { id: number; name: string; timeZone?: string }
/**
 * CareStack patient. CREATE field names verified live (v1.0.54): `dob` (not
 * dateOfBirth), integer `gender` (4 = Not Set), `defaultLocationId`, `mobile`
 * (not phones[]). The create/search response carries the id as `id`.
 */
export interface CsPatient {
  id?: number | string
  patientId?: number | string
  firstName?: string
  lastName?: string
  dob?: string                      // ISO date
  gender?: number                   // integer enum; 4 = Not Set
  defaultLocationId?: number | string
  email?: string
  mobile?: string
  status?: number
}
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
