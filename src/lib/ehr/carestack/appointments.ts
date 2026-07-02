/**
 * CareStack appointment adapter — the write side of online booking.
 *
 * Turns an LI appointment into a real CareStack appointment: resolve (find or
 * create) the CareStack patient, map the LI row → CsAppointment using the org's
 * booking_settings defaults (falling back to the first location/provider from the
 * API), create it, and hand back CareStack's appointment id. Also cancels.
 *
 * Called only by the EHR sync seam, and only when getCareStackConfig returned a
 * live config — so this module assumes it has valid credentials.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptField } from '@/lib/encryption'
import type { CareStackConfig } from './client'
import {
  getCsLocations,
  getCsProviders,
  searchCsPatients,
  createCsPatient,
  createCsAppointment,
  cancelCsAppointment,
} from './scheduler'
import { upsertCareStackPatient } from './match'

type LeadRow = Record<string, unknown>
type AppointmentRow = {
  id: string
  organization_id: string
  lead_id: string
  scheduled_at: string
  duration_minutes?: number | null
}
export type CareStackBookingDefaults = {
  carestack_location_id?: string | null
  carestack_provider_id?: string | null
  carestack_operatory_id?: string | null
  carestack_appointment_type?: string | null
}

function leadPii(lead: LeadRow) {
  return {
    firstName: (lead.first_name as string) || '',
    lastName: (lead.last_name as string) || '',
    email: decryptField(lead.email as string | null | undefined),
    phone:
      decryptField(lead.phone_formatted as string | null | undefined) ||
      decryptField(lead.phone as string | null | undefined),
  }
}

/**
 * Find (or create) the CareStack patient for an LI lead. Prefers an existing
 * lead→patient mapping, then an email search, then creates. Records the mapping.
 */
export async function ensureCareStackPatient(
  supabase: SupabaseClient,
  config: CareStackConfig,
  orgId: string,
  lead: LeadRow,
): Promise<{ patientId: string; isNew: boolean }> {
  // 1. Existing mapping for this lead?
  const { data: mapped } = await supabase
    .from('patients')
    .select('ehr_patient_id')
    .eq('organization_id', orgId)
    .eq('lead_id', lead.id as string)
    .eq('ehr_source', 'carestack')
    .limit(1)
    .maybeSingle()
  if (mapped?.ehr_patient_id) return { patientId: String(mapped.ehr_patient_id), isNew: false }

  const { firstName, lastName, email, phone } = leadPii(lead)

  // 2. Search CareStack by email.
  let patientId: string | null = null
  if (email) {
    try {
      const results = await searchCsPatients(config, { email, limit: 5 })
      if (Array.isArray(results) && results.length > 0) patientId = String(results[0].id)
    } catch {
      // fall through to create
    }
  }

  // 3. Create if still unresolved.
  let isNew = false
  if (!patientId) {
    const created = await createCsPatient(config, {
      firstName,
      lastName,
      email: email ?? undefined,
      mobileNumber: phone ?? undefined,
    })
    patientId = String(created.id)
    isNew = true
  }

  // 4. Record the LI-side mapping (best-effort; links the lead by hash).
  try {
    await upsertCareStackPatient(supabase, orgId, {
      ehr_patient_id: patientId,
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
    })
  } catch {
    // Mapping is a cache; a failure here must not fail the booking write.
  }

  return { patientId, isNew }
}

async function resolveLocationId(config: CareStackConfig, settings: CareStackBookingDefaults): Promise<string> {
  if (settings.carestack_location_id) return settings.carestack_location_id
  const locations = await getCsLocations(config)
  if (!locations?.length) throw new Error('No CareStack location configured or available')
  return String(locations[0].id)
}

async function resolveProviderId(config: CareStackConfig, settings: CareStackBookingDefaults): Promise<string> {
  if (settings.carestack_provider_id) return settings.carestack_provider_id
  const providers = await getCsProviders(config)
  if (!providers?.length) throw new Error('No CareStack provider configured or available')
  return String(providers[0].id)
}

/**
 * Create a CareStack appointment for an LI appointment row. Returns CareStack's
 * appointment id (as text).
 */
export async function pushAppointmentToCareStack(
  supabase: SupabaseClient,
  config: CareStackConfig,
  args: { appointment: AppointmentRow; lead: LeadRow; settings: CareStackBookingDefaults },
): Promise<string> {
  const { appointment, lead, settings } = args
  const { patientId, isNew } = await ensureCareStackPatient(supabase, config, appointment.organization_id, lead)
  const [locationId, providerId] = await Promise.all([
    resolveLocationId(config, settings),
    resolveProviderId(config, settings),
  ])

  const start = new Date(appointment.scheduled_at)
  const duration = appointment.duration_minutes ?? 60
  const end = new Date(start.getTime() + duration * 60_000)

  const created = await createCsAppointment(config, {
    patientId,
    locationId,
    providerId,
    operatoryId: settings.carestack_operatory_id ?? undefined,
    appointmentType: settings.carestack_appointment_type ?? 'Consultation',
    scheduledStart: start.toISOString(),
    scheduledEnd: end.toISOString(),
    duration,
    status: 'scheduled',
    isNewPatient: isNew,
  })

  return String(created.appointmentId)
}

export async function cancelAppointmentInCareStack(
  config: CareStackConfig,
  carestackAppointmentId: string,
): Promise<void> {
  await cancelCsAppointment(config, carestackAppointmentId)
}
