/**
 * CareStack patient ↔ marketing lead matcher.
 *
 * When CareStack tells us about a patient (via webhook or sync), we try to link
 * it back to a lead in our system so attribution closes the loop:
 *   - email_hash match     → highest confidence (1.00)
 *   - phone_hash match     → high confidence (0.90)
 *   - first+last+DOB       → medium confidence (0.70) — handles patients who
 *                            booked online with a different email/phone than
 *                            they used at the consult
 *   - no match             → patients row created, lead_id stays null (walk-in/referral)
 *
 * The patients table holds the bridge so we don't re-run matching on every event.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { searchHash } from '@/lib/encryption'

export type CareStackPatientForMatch = {
  /** CareStack patientId */
  ehr_patient_id: number | string
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  phone?: string | null            // any format; we normalize before hashing
  dob?: string | null              // YYYY-MM-DD or any parseable
  default_location_id?: number | null
  account_id?: number | null
  status?: number | null
}

export type MatchResult = {
  patientRowId: string
  leadId: string | null
  matchMethod: 'email_hash' | 'phone_hash' | 'name_dob' | 'manual' | 'webhook_meta' | 'unmatched'
  matchConfidence: number
  isNew: boolean
}

/**
 * Upsert a patient row and best-effort link to a lead.
 *
 * Idempotent on (organization_id, ehr_source, ehr_patient_id). If the bridge already
 * exists, we refresh the cached fields but do NOT re-run matching (staff may have
 * manually corrected the link).
 */
export async function upsertCareStackPatient(
  supabase: SupabaseClient,
  organizationId: string,
  patient: CareStackPatientForMatch
): Promise<MatchResult> {
  const ehrId = String(patient.ehr_patient_id)
  const emailHash = patient.email ? searchHash(patient.email) : null
  const phoneE164 = patient.phone ? toE164(patient.phone) : null
  const phoneHash = phoneE164 ? searchHash(phoneE164) : null

  // Check if we already have this patient → respect existing link.
  const { data: existing } = await supabase
    .from('patients')
    .select('id, lead_id, match_method, match_confidence')
    .eq('organization_id', organizationId)
    .eq('ehr_source', 'carestack')
    .eq('ehr_patient_id', ehrId)
    .maybeSingle()

  // Always refresh the cached PII fields (CareStack is source of truth).
  const baseRow = {
    organization_id: organizationId,
    ehr_source: 'carestack' as const,
    ehr_patient_id: ehrId,
    first_name: patient.first_name ?? null,
    last_name: patient.last_name ?? null,
    email: patient.email ?? null,
    email_hash: emailHash,
    phone_e164: phoneE164,
    phone_hash: phoneHash,
    dob: patient.dob ? toIsoDate(patient.dob) : null,
    default_location_id: patient.default_location_id ?? null,
    account_id: patient.account_id ?? null,
    status: patient.status ?? null,
  }

  if (existing) {
    await supabase.from('patients').update(baseRow).eq('id', existing.id)
    return {
      patientRowId: existing.id as string,
      leadId: (existing.lead_id as string | null) ?? null,
      matchMethod: ((existing.match_method as MatchResult['matchMethod']) || 'unmatched'),
      matchConfidence: (existing.match_confidence as number) ?? 0,
      isNew: false,
    }
  }

  // New patient — try to find a matching lead.
  const match = await findMatchingLead(supabase, organizationId, {
    emailHash,
    phoneHash,
    firstName: patient.first_name,
    lastName: patient.last_name,
    dob: baseRow.dob,
  })

  const { data: inserted, error } = await supabase
    .from('patients')
    .insert({
      ...baseRow,
      lead_id: match.leadId,
      match_method: match.method,
      match_confidence: match.confidence,
    })
    .select('id')
    .single()

  if (error || !inserted) {
    throw new Error(`Failed to upsert CareStack patient: ${error?.message || 'unknown'}`)
  }

  return {
    patientRowId: inserted.id as string,
    leadId: match.leadId,
    matchMethod: match.method,
    matchConfidence: match.confidence,
    isNew: true,
  }
}

// ── internals ────────────────────────────────────────────────────────────

type MatchAttempt = {
  leadId: string | null
  method: MatchResult['matchMethod']
  confidence: number
}

async function findMatchingLead(
  supabase: SupabaseClient,
  organizationId: string,
  candidates: {
    emailHash: string | null
    phoneHash: string | null
    firstName?: string | null
    lastName?: string | null
    dob: string | null  // YYYY-MM-DD
  }
): Promise<MatchAttempt> {
  // 1. email_hash (highest confidence)
  if (candidates.emailHash) {
    const { data } = await supabase
      .from('leads')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('email_hash', candidates.emailHash)
      .limit(1)
      .maybeSingle()
    if (data?.id) return { leadId: data.id as string, method: 'email_hash', confidence: 1.0 }
  }

  // 2. phone_hash
  if (candidates.phoneHash) {
    const { data } = await supabase
      .from('leads')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('phone_hash', candidates.phoneHash)
      .limit(1)
      .maybeSingle()
    if (data?.id) return { leadId: data.id as string, method: 'phone_hash', confidence: 0.9 }
  }

  // 3. first + last + dob (medium — only when all three present)
  if (candidates.firstName && candidates.lastName && candidates.dob) {
    const { data } = await supabase
      .from('leads')
      .select('id')
      .eq('organization_id', organizationId)
      .ilike('first_name', candidates.firstName)
      .ilike('last_name', candidates.lastName)
      .eq('date_of_birth', candidates.dob)
      .limit(2)
    // Only accept name+dob match if it's unique — otherwise too risky.
    if (data && data.length === 1) {
      return { leadId: data[0].id as string, method: 'name_dob', confidence: 0.7 }
    }
  }

  return { leadId: null, method: 'unmatched', confidence: 0 }
}

function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (!digits) return phone
  if (phone.startsWith('+')) return `+${digits}`
  // CareStack patients are US-centric per the brief; default to +1 if no country code.
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return `+${digits}`
}

function toIsoDate(input: string): string | null {
  const d = new Date(input)
  if (isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}
