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
