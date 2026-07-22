/**
 * Existing-patient reconciliation
 *
 * Decides whether an inbound contact already exists as a synced EHR patient,
 * using the local `patients` mirror (kept current by the CareStack
 * /sync/patients cron) — no live EHR API call per lead. Matching is on the
 * same deterministic search hashes both tables carry (email_hash preferred over
 * phone_hash, mirroring the confidence order in ehr/carestack/match.ts).
 *
 * Used at lead ingestion and as a defensive gate in speed-to-lead so existing
 * patients are never treated as net-new sales leads or auto-outreached.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type PatientHashMatch = {
  patientId: string
  matchMethod: 'email_hash' | 'phone_hash'
}

/**
 * True when the patient has a visit that PREDATES the given moment.
 *
 * WHY THIS EXISTS: a CareStack patient record is created at BOOKING, not at the
 * first visit. So "has a patient record" does NOT mean "established patient" —
 * a prospect who books through LI gets a record immediately, and matching on the
 * mirror alone would then re-classify that brand-new lead as an existing patient
 * and pull them out of the sales funnel. 115 of the 515 currently-matching
 * un-worked leads have no visit history at all.
 *
 * A prior visit is the ground truth for "was already a patient before this
 * enquiry". Absence of one is NOT proof of the opposite (only ~26k of 83k mirror
 * rows have synced appointments), which is why callers use this to gate the
 * disruptive action (parking a lead) and not the harmless one (setting the flag).
 */
export async function hasVisitBefore(
  supabase: SupabaseClient,
  patientId: string,
  before: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('ehr_appointments')
    .select('id')
    .eq('patient_id', patientId)
    .lt('start_at', before)
    .limit(1)
    .maybeSingle()
  return !!data
}

/**
 * Return the matching synced-patient row for a contact (by search hashes), or
 * null. Best-effort read — callers wrap in try/catch.
 */
export async function findExistingPatientByHash(
  supabase: SupabaseClient,
  organizationId: string,
  hashes: { emailHash?: string | null; phoneHash?: string | null }
): Promise<PatientHashMatch | null> {
  const { emailHash, phoneHash } = hashes
  if (!emailHash && !phoneHash) return null

  if (emailHash) {
    const { data } = await supabase
      .from('patients')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('email_hash', emailHash)
      .limit(1)
      .maybeSingle()
    if (data) return { patientId: (data as { id: string }).id, matchMethod: 'email_hash' }
  }

  if (phoneHash) {
    const { data } = await supabase
      .from('patients')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('phone_hash', phoneHash)
      .limit(1)
      .maybeSingle()
    if (data) return { patientId: (data as { id: string }).id, matchMethod: 'phone_hash' }
  }

  return null
}

/**
 * Flag a lead as an existing patient and link the bridge both ways.
 * Idempotent + best-effort — callers wrap in try/catch.
 */
export async function markLeadAsExistingPatient(
  supabase: SupabaseClient,
  leadId: string,
  organizationId: string,
  patientId: string
): Promise<void> {
  await supabase
    .from('leads')
    .update({ is_existing_patient: true, matched_patient_id: patientId })
    .eq('id', leadId)
    .eq('organization_id', organizationId)

  // Backfill the patient → lead link only when the patient isn't already
  // bound to a lead (never steal an existing binding).
  await supabase
    .from('patients')
    .update({ lead_id: leadId })
    .eq('id', patientId)
    .is('lead_id', null)
}
