/**
 * CareStack incremental sync runners.
 *
 * Each runner calls the matching `/api/v1.0/sync/{resource}` endpoint with
 * `modifiedSince` = the high-water mark from the last successful run, paginates
 * through `continueToken` until exhausted, upserts our mirror tables, and emits
 * downstream events to the `events` table for the forwarder to ship.
 *
 * Brief reference: PDF §"Sync APIs" (page 43+). Status enums per
 * §"Treatment Plan" (page 38) — TreatmentProcedure shares the same set:
 *   1 Proposed | 2 Scheduled | 3 Accepted | 4 Rejected | 5 Alternative |
 *   6 Hold    | 7 Referred Out | 8 Completed
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { carestackFetch, type CareStackConfig } from './client'
import { upsertCareStackPatient } from './match'

// ── shared ──────────────────────────────────────────────────────────────

type SyncCursor = {
  modifiedSince: string | null
  continueToken: string | null
}

type RunResult = {
  resource: string
  fetched: number
  upserted: number
  events_emitted: number
  status: 'success' | 'partial' | 'failed'
  error?: string
  high_water?: string | null
}

const PAGE_SIZE = 200
const MAX_PAGES_PER_RUN = 10  // safety cap so a giant backfill doesn't time out the cron

async function loadCursor(
  supabase: SupabaseClient,
  organizationId: string,
  resource: string
): Promise<SyncCursor> {
  const { data } = await supabase
    .from('ehr_sync_state')
    .select('last_synced_at, continue_token')
    .eq('organization_id', organizationId)
    .eq('ehr_source', 'carestack')
    .eq('resource', resource)
    .maybeSingle()
  return {
    modifiedSince: (data?.last_synced_at as string | null) ?? null,
    continueToken: (data?.continue_token as string | null) ?? null,
  }
}

async function saveCursor(
  supabase: SupabaseClient,
  organizationId: string,
  resource: string,
  patch: {
    last_synced_at?: string | null
    continue_token?: string | null
    last_run_status: 'success' | 'partial' | 'failed'
    last_run_count: number
    last_run_error?: string | null
  }
) {
  const row = {
    organization_id: organizationId,
    ehr_source: 'carestack',
    resource,
    last_run_at: new Date().toISOString(),
    ...patch,
  }
  await supabase
    .from('ehr_sync_state')
    .upsert(row, { onConflict: 'organization_id,ehr_source,resource' })
}

/**
 * Read a field from a CareStack response object, accepting both camelCase and PascalCase.
 * Returns the first matching key's value (or undefined). The PDF docs are inconsistent
 * across endpoints — treatment-procedures examples use camelCase, invoices use PascalCase.
 * We don't trust either; we look for both.
 */
function pickField<T = unknown>(row: Record<string, unknown>, ...candidates: string[]): T | undefined {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== null) return row[key] as T
    // Try both first-letter-toggled variants for each candidate.
    const flipped = key.charAt(0) === key.charAt(0).toUpperCase()
      ? key.charAt(0).toLowerCase() + key.slice(1)
      : key.charAt(0).toUpperCase() + key.slice(1)
    if (row[flipped] !== undefined && row[flipped] !== null) return row[flipped] as T
  }
  return undefined
}

async function emitEvent(
  supabase: SupabaseClient,
  organizationId: string,
  leadId: string | null,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  await supabase.from('events').insert({
    organization_id: organizationId,
    lead_id: leadId,
    event_type: eventType,
    payload,
    occurred_at: new Date().toISOString(),
    // Forwarder picks these up as 'pending'. lead.treatment_accepted /
    // lead.treatment_completed / lead.payment.received are mapped in forward-events route.
  })
}

// ── 1. Patients sync ────────────────────────────────────────────────────

// Patient resource fields (per PDF section 3) — defensively handled via pickField
// since CareStack's response casing has been inconsistent across endpoints.
type CareStackPatientSyncRow = Record<string, unknown>

export async function syncPatients(
  supabase: SupabaseClient,
  organizationId: string,
  config: CareStackConfig
): Promise<RunResult> {
  const cursor = await loadCursor(supabase, organizationId, 'patients')
  let upserted = 0
  let fetched = 0
  let pages = 0
  let continueToken: string | null = cursor.continueToken
  let highWater: string | null = cursor.modifiedSince

  try {
    while (pages < MAX_PAGES_PER_RUN) {
      const query: Record<string, string | number> = { pageSize: PAGE_SIZE }
      if (continueToken) query.continueToken = continueToken
      else if (cursor.modifiedSince) query.modifiedSince = cursor.modifiedSince

      type Resp = { results?: CareStackPatientSyncRow[]; continueToken?: string | null } | CareStackPatientSyncRow[]
      const raw = await carestackFetch<Resp>(config, '/sync/patients', { query })
      const list = Array.isArray(raw) ? raw : (raw.results || [])
      const nextToken = Array.isArray(raw) ? null : (raw.continueToken ?? null)

      for (const raw of list) {
        const p = raw as Record<string, unknown>
        const ehrId = pickField<number>(p, 'id', 'Id', 'patientId', 'PatientId')
        if (ehrId === undefined) continue
        await upsertCareStackPatient(supabase, organizationId, {
          ehr_patient_id: ehrId,
          first_name: pickField<string>(p, 'firstName', 'FirstName') ?? null,
          last_name: pickField<string>(p, 'lastName', 'LastName') ?? null,
          email: pickField<string>(p, 'email', 'Email') ?? null,
          phone: pickField<string>(p, 'mobile', 'Mobile', 'phoneWithExt', 'PhoneWithExt') ?? null,
          dob: pickField<string>(p, 'dob', 'Dob', 'DOB', 'dateOfBirth', 'DateOfBirth') ?? null,
          default_location_id: pickField<number>(p, 'defaultLocationId', 'DefaultLocationId') ?? null,
          account_id: pickField<number>(p, 'accountId', 'AccountId') ?? null,
          status: pickField<number>(p, 'status', 'Status') ?? null,
        })
        upserted++
        fetched++
      }

      pages++
      if (!nextToken) {
        continueToken = null
        // High-water = now() if we exhausted the queue. CareStack doesn't return
        // per-record lastModified on this endpoint so we use the run timestamp.
        highWater = new Date().toISOString()
        break
      }
      continueToken = nextToken
    }

    const status: 'success' | 'partial' = continueToken ? 'partial' : 'success'
    await saveCursor(supabase, organizationId, 'patients', {
      last_synced_at: status === 'success' ? highWater : cursor.modifiedSince,
      continue_token: continueToken,
      last_run_status: status,
      last_run_count: fetched,
    })
    return { resource: 'patients', fetched, upserted, events_emitted: 0, status, high_water: highWater }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown'
    await saveCursor(supabase, organizationId, 'patients', {
      continue_token: continueToken,
      last_run_status: 'failed',
      last_run_count: fetched,
      last_run_error: message,
    })
    return { resource: 'patients', fetched, upserted, events_emitted: 0, status: 'failed', error: message }
  }
}

// ── 2. Treatment procedures sync (revenue events!) ──────────────────────

// CareStack docs show camelCase examples for this endpoint, but other endpoints
// (invoices, treatment-conditions) use PascalCase, and a parallel production
// integration in another repo doesn't actually parse this response. We accept
// both casings via the `pickField` helper below to avoid silently dropping
// revenue events on a field-name mismatch in production.
type CareStackTreatmentProcedureRow = Record<string, unknown>

const PROC_STATUS_ACCEPTED = 3
const PROC_STATUS_COMPLETED = 8

export async function syncTreatmentProcedures(
  supabase: SupabaseClient,
  organizationId: string,
  config: CareStackConfig
): Promise<RunResult> {
  const cursor = await loadCursor(supabase, organizationId, 'treatment_procedures')
  let upserted = 0
  let fetched = 0
  let events = 0
  let pages = 0
  let continueToken: string | null = cursor.continueToken
  let highWater: string | null = cursor.modifiedSince

  try {
    while (pages < MAX_PAGES_PER_RUN) {
      const query: Record<string, string | number | boolean> = { pageSize: PAGE_SIZE, includeDeleted: true }
      if (continueToken) query.continueToken = continueToken
      else if (cursor.modifiedSince) query.modifiedSince = cursor.modifiedSince

      type Resp = { results?: CareStackTreatmentProcedureRow[]; continueToken?: string | null }
      const raw = await carestackFetch<Resp>(config, '/sync/treatment-procedures', { query })
      const list = raw.results || []
      const nextToken = raw.continueToken ?? null

      for (const raw of list) {
        const p = raw as Record<string, unknown>
        // Pull every field via case-tolerant lookup (see pickField helper).
        const procId = pickField<number>(p, 'id', 'Id', 'procedureId', 'ProcedureId')
        const patientId = pickField<number>(p, 'patientId', 'PatientId')
        if (procId === undefined || patientId === undefined) continue

        const patient = await ensurePatientStub(supabase, organizationId, patientId)
        if (!patient) continue

        const treatmentPlanId = pickField<number>(p, 'treatmentPlanId', 'TreatmentPlanId')
        const treatmentPlanPhaseId = pickField<number>(p, 'treatmentPlanPhaseId', 'TreatmentPlanPhaseId')
        const appointmentId = pickField<number>(p, 'appointmentId', 'AppointmentId')
        const providerId = pickField<number>(p, 'providerId', 'ProviderId')
        const locationId = pickField<number>(p, 'locationId', 'LocationId')
        const procedureCodeId = pickField<number>(p, 'procedureCodeId', 'ProcedureCodeId')
        const tooth = pickField<string>(p, 'tooth', 'Tooth', 'toothNumber', 'ToothNumber')
        const surfaces = pickField<Record<string, number>>(p, 'surfaces', 'Surfaces', 'toothSurfaces', 'ToothSurfaces')
        const patientEstimate = pickField<number>(p, 'patientEstimate', 'PatientEstimate')
        const insuranceEstimate = pickField<number>(p, 'insuranceEstimate', 'InsuranceEstimate')
        const statusId = pickField<number>(p, 'statusId', 'StatusId', 'status', 'Status')
        const proposedDateRaw = pickField<string>(p, 'proposedDate', 'ProposedDate')
        const dateOfServiceRaw = pickField<string>(p, 'dateOfService', 'DateOfService')
        const lastUpdatedRaw = pickField<string>(p, 'lastUpdatedOn', 'LastUpdatedOn')
        const isDeleted = !!pickField<boolean>(p, 'isDeleted', 'IsDeleted')

        const proposed = proposedDateRaw ? new Date(proposedDateRaw).toISOString() : null
        const dateOfService = dateOfServiceRaw ? new Date(dateOfServiceRaw).toISOString() : null
        const lastUpdated = lastUpdatedRaw ? new Date(lastUpdatedRaw).toISOString() : null
        if (lastUpdated && (!highWater || lastUpdated > highWater)) highWater = lastUpdated

        const { data: existing } = await supabase
          .from('treatment_procedures')
          .select('id, status_id, last_forwarded_status_id')
          .eq('organization_id', organizationId)
          .eq('ehr_source', 'carestack')
          .eq('ehr_procedure_id', procId)
          .maybeSingle()

        const baseRow = {
          organization_id: organizationId,
          patient_id: patient.patient_row_id,
          ehr_procedure_id: procId,
          ehr_source: 'carestack',
          ehr_treatment_plan_id: treatmentPlanId ?? null,
          ehr_treatment_plan_phase_id: treatmentPlanPhaseId ?? null,
          ehr_appointment_id: appointmentId ?? null,
          ehr_provider_id: providerId ?? null,
          ehr_location_id: locationId ?? null,
          procedure_code_id: procedureCodeId ?? null,
          tooth: tooth ?? null,
          surfaces: surfaces ?? null,
          patient_estimate: patientEstimate ?? null,
          insurance_estimate: insuranceEstimate ?? null,
          status_id: statusId ?? null,
          proposed_date: proposed,
          date_of_service: dateOfService,
          is_deleted: isDeleted,
          ehr_last_updated_on: lastUpdated,
        }

        let procRowId: string
        if (existing) {
          await supabase.from('treatment_procedures').update(baseRow).eq('id', existing.id)
          procRowId = existing.id as string
        } else {
          const { data: inserted } = await supabase
            .from('treatment_procedures')
            .insert(baseRow)
            .select('id')
            .single()
          if (!inserted) continue
          procRowId = inserted.id as string
        }

        upserted++
        fetched++

        // Emit one event per status transition we care about, only if not already forwarded
        // for that exact status. last_forwarded_status_id prevents re-firing on resync.
        const lastForwarded = (existing?.last_forwarded_status_id as number | null) ?? null
        const totalValue = (patientEstimate ?? 0) + (insuranceEstimate ?? 0)

        if (statusId === PROC_STATUS_ACCEPTED && lastForwarded !== PROC_STATUS_ACCEPTED && !isDeleted) {
          await emitEvent(supabase, organizationId, patient.lead_id, 'lead.treatment_accepted', {
            ehr_source: 'carestack',
            ehr_procedure_id: procId,
            ehr_patient_id: patientId,
            ehr_treatment_plan_id: treatmentPlanId,
            value: totalValue,
            currency: 'USD',
            patient_estimate: patientEstimate,
            insurance_estimate: insuranceEstimate,
            procedure_code_id: procedureCodeId,
            proposed_date: proposed,
          })
          events++
          await supabase
            .from('treatment_procedures')
            .update({ last_forwarded_status_id: PROC_STATUS_ACCEPTED, last_forwarded_at: new Date().toISOString() })
            .eq('id', procRowId)
        }

        if (statusId === PROC_STATUS_COMPLETED && lastForwarded !== PROC_STATUS_COMPLETED && !isDeleted) {
          await emitEvent(supabase, organizationId, patient.lead_id, 'lead.treatment_completed', {
            ehr_source: 'carestack',
            ehr_procedure_id: procId,
            ehr_patient_id: patientId,
            value: totalValue,
            currency: 'USD',
            date_of_service: dateOfService,
            procedure_code_id: procedureCodeId,
          })
          events++
          await supabase
            .from('treatment_procedures')
            .update({ last_forwarded_status_id: PROC_STATUS_COMPLETED, last_forwarded_at: new Date().toISOString() })
            .eq('id', procRowId)
        }
      }

      pages++
      if (!nextToken) {
        continueToken = null
        if (!highWater || highWater < new Date().toISOString()) {
          highWater = new Date().toISOString()
        }
        break
      }
      continueToken = nextToken
    }

    const status: 'success' | 'partial' = continueToken ? 'partial' : 'success'
    await saveCursor(supabase, organizationId, 'treatment_procedures', {
      last_synced_at: status === 'success' ? highWater : cursor.modifiedSince,
      continue_token: continueToken,
      last_run_status: status,
      last_run_count: fetched,
    })
    return { resource: 'treatment_procedures', fetched, upserted, events_emitted: events, status, high_water: highWater }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown'
    await saveCursor(supabase, organizationId, 'treatment_procedures', {
      continue_token: continueToken,
      last_run_status: 'failed',
      last_run_count: fetched,
      last_run_error: message,
    })
    return { resource: 'treatment_procedures', fetched, upserted, events_emitted: events, status: 'failed', error: message }
  }
}

// ── 3. Invoices sync (collected revenue) ────────────────────────────────

// PDF examples for /sync/invoices use PascalCase. The parallel production integration
// in another repo doesn't actually use this endpoint, so PascalCase is unverified
// against real responses. We accept both casings via pickField.
type CareStackInvoiceRow = Record<string, unknown>

export async function syncInvoices(
  supabase: SupabaseClient,
  organizationId: string,
  config: CareStackConfig
): Promise<RunResult> {
  const cursor = await loadCursor(supabase, organizationId, 'invoices')
  let upserted = 0
  let fetched = 0
  let events = 0
  let pages = 0
  let continueToken: string | null = cursor.continueToken
  let highWater: string | null = cursor.modifiedSince

  try {
    while (pages < MAX_PAGES_PER_RUN) {
      const query: Record<string, string | number> = { pageSize: PAGE_SIZE }
      if (continueToken) query.continueToken = continueToken
      else if (cursor.modifiedSince) query.modifiedSince = cursor.modifiedSince

      type Resp = { results?: CareStackInvoiceRow[]; continueToken?: string | null } | CareStackInvoiceRow[]
      const raw = await carestackFetch<Resp>(config, '/sync/invoices', { query })
      const list = Array.isArray(raw) ? raw : (raw.results || [])
      const nextToken = Array.isArray(raw) ? null : (raw.continueToken ?? null)

      for (const raw of list) {
        const inv = raw as Record<string, unknown>
        const invoiceId = pickField<number>(inv, 'InvoiceId', 'invoiceId', 'id', 'Id')
        if (invoiceId === undefined) continue

        const invoiceNumber = pickField<number>(inv, 'InvoiceNumber', 'invoiceNumber')
        const amount = pickField<number>(inv, 'Amount', 'amount') ?? 0
        const unapplied = pickField<number>(inv, 'UnappliedAmount', 'unappliedAmount')
        const providerId = pickField<number>(inv, 'ProviderId', 'providerId')
        const locationId = pickField<number>(inv, 'LocationId', 'locationId')
        const isDeleted = !!pickField<boolean>(inv, 'IsDeleted', 'isDeleted')
        const isNsf = !!pickField<boolean>(inv, 'IsNsf', 'isNsf')
        const patientId = pickField<number>(inv, 'PatientId', 'patientId')
        const lastUpdatedRaw = pickField<string>(inv, 'LastUpdatedOn', 'lastUpdatedOn')
        const paymentCategory = pickField<string>(inv, 'PaymentCategory', 'paymentCategory')
        const paymentDateRaw = pickField<string>(inv, 'PaymentDate', 'paymentDate')
        const invoiceType = pickField<number>(inv, 'InvoiceType', 'invoiceType')
        const invoiceSource = pickField<number>(inv, 'InvoiceSource', 'invoiceSource')
        const paymentTypeId = pickField<number>(inv, 'PaymentTypeId', 'paymentTypeId')

        const patient = patientId ? await ensurePatientStub(supabase, organizationId, patientId) : null

        const lastUpdated = lastUpdatedRaw ? new Date(lastUpdatedRaw).toISOString() : null
        if (lastUpdated && (!highWater || lastUpdated > highWater)) highWater = lastUpdated

        const baseRow = {
          organization_id: organizationId,
          patient_id: patient?.patient_row_id ?? null,
          ehr_invoice_id: invoiceId,
          ehr_invoice_number: invoiceNumber ?? null,
          ehr_source: 'carestack',
          amount,
          unapplied_amount: unapplied ?? null,
          ehr_provider_id: providerId ?? null,
          ehr_location_id: locationId ?? null,
          payment_category: paymentCategory ?? null,
          invoice_type: invoiceType ?? null,
          invoice_source: invoiceSource ?? null,
          payment_type_id: paymentTypeId ?? null,
          payment_date: paymentDateRaw ? new Date(paymentDateRaw).toISOString() : null,
          is_nsf: isNsf,
          is_deleted: isDeleted,
          ehr_last_updated_on: lastUpdated,
        }

        const { data: existing } = await supabase
          .from('invoices')
          .select('id, forwarded')
          .eq('organization_id', organizationId)
          .eq('ehr_source', 'carestack')
          .eq('ehr_invoice_id', invoiceId)
          .maybeSingle()

        let invRowId: string
        if (existing) {
          await supabase.from('invoices').update(baseRow).eq('id', existing.id)
          invRowId = existing.id as string
        } else {
          const { data: inserted } = await supabase
            .from('invoices')
            .insert(baseRow)
            .select('id')
            .single()
          if (!inserted) continue
          invRowId = inserted.id as string
        }

        upserted++
        fetched++

        // Emit a payment.received event for each new, non-deleted, non-NSF invoice.
        // Skip if forwarded already (idempotency on resync).
        const alreadyForwarded = (existing?.forwarded as boolean) || false
        if (!alreadyForwarded && !isDeleted && !isNsf && amount > 0) {
          await emitEvent(supabase, organizationId, patient?.lead_id ?? null, 'lead.payment.received', {
            ehr_source: 'carestack',
            ehr_invoice_id: invoiceId,
            ehr_invoice_number: invoiceNumber,
            ehr_patient_id: patientId,
            value: amount,
            currency: 'USD',
            payment_category: paymentCategory,
            payment_date: paymentDateRaw,
            invoice_type: invoiceType,
            invoice_source: invoiceSource,
          })
          events++
          await supabase
            .from('invoices')
            .update({ forwarded: true, forwarded_at: new Date().toISOString() })
            .eq('id', invRowId)
        }
      }

      pages++
      if (!nextToken) {
        continueToken = null
        if (!highWater) highWater = new Date().toISOString()
        break
      }
      continueToken = nextToken
    }

    const status: 'success' | 'partial' = continueToken ? 'partial' : 'success'
    await saveCursor(supabase, organizationId, 'invoices', {
      last_synced_at: status === 'success' ? highWater : cursor.modifiedSince,
      continue_token: continueToken,
      last_run_status: status,
      last_run_count: fetched,
    })
    return { resource: 'invoices', fetched, upserted, events_emitted: events, status, high_water: highWater }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown'
    await saveCursor(supabase, organizationId, 'invoices', {
      continue_token: continueToken,
      last_run_status: 'failed',
      last_run_count: fetched,
      last_run_error: message,
    })
    return { resource: 'invoices', fetched, upserted, events_emitted: events, status: 'failed', error: message }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

/**
 * Ensure a patients row exists for a given CareStack patientId.
 * If not, create a stub (no name/email — those fill in on the next patient sync).
 * Returns the bridge row id + linked lead_id (if any).
 */
async function ensurePatientStub(
  supabase: SupabaseClient,
  organizationId: string,
  ehrPatientId: number
): Promise<{ patient_row_id: string; lead_id: string | null } | null> {
  const { data: existing } = await supabase
    .from('patients')
    .select('id, lead_id')
    .eq('organization_id', organizationId)
    .eq('ehr_source', 'carestack')
    .eq('ehr_patient_id', String(ehrPatientId))
    .maybeSingle()

  if (existing) {
    return { patient_row_id: existing.id as string, lead_id: (existing.lead_id as string | null) ?? null }
  }

  const { data: inserted } = await supabase
    .from('patients')
    .insert({
      organization_id: organizationId,
      ehr_source: 'carestack',
      ehr_patient_id: String(ehrPatientId),
      match_method: 'unmatched',
      match_confidence: 0,
    })
    .select('id, lead_id')
    .single()

  if (!inserted) return null
  return { patient_row_id: inserted.id as string, lead_id: null }
}
