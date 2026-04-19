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

type CareStackPatientSyncRow = {
  id: number
  firstName?: string
  lastName?: string
  email?: string
  mobile?: string
  phoneWithExt?: string
  dob?: string
  defaultLocationId?: number
  accountId?: number
  status?: number
}

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

      for (const p of list) {
        await upsertCareStackPatient(supabase, organizationId, {
          ehr_patient_id: p.id,
          first_name: p.firstName ?? null,
          last_name: p.lastName ?? null,
          email: p.email ?? null,
          phone: p.mobile ?? p.phoneWithExt ?? null,
          dob: p.dob ?? null,
          default_location_id: p.defaultLocationId ?? null,
          account_id: p.accountId ?? null,
          status: p.status ?? null,
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

type CareStackTreatmentProcedureRow = {
  id: number
  patientId: number
  treatmentPlanId?: number
  treatmentPlanPhaseId?: number
  procedureCodeId?: number
  appointmentId?: number
  providerId?: number
  locationId?: number
  tooth?: string
  surfaces?: Record<string, number>
  patientEstimate?: number
  insuranceEstimate?: number
  statusId?: number
  proposedDate?: string
  dateOfService?: string
  isDeleted?: boolean
  lastUpdatedOn?: string
}

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

      for (const p of list) {
        // Resolve our patient row (auto-create if first time we see this CareStack patientId).
        const patient = await ensurePatientStub(supabase, organizationId, p.patientId)
        if (!patient) continue

        // Upsert the procedure mirror row.
        const proposed = p.proposedDate ? new Date(p.proposedDate).toISOString() : null
        const dateOfService = p.dateOfService ? new Date(p.dateOfService).toISOString() : null
        const lastUpdated = p.lastUpdatedOn ? new Date(p.lastUpdatedOn).toISOString() : null
        if (lastUpdated && (!highWater || lastUpdated > highWater)) highWater = lastUpdated

        const { data: existing } = await supabase
          .from('treatment_procedures')
          .select('id, status_id, last_forwarded_status_id')
          .eq('organization_id', organizationId)
          .eq('ehr_source', 'carestack')
          .eq('ehr_procedure_id', p.id)
          .maybeSingle()

        const baseRow = {
          organization_id: organizationId,
          patient_id: patient.patient_row_id,
          ehr_procedure_id: p.id,
          ehr_source: 'carestack',
          ehr_treatment_plan_id: p.treatmentPlanId ?? null,
          ehr_treatment_plan_phase_id: p.treatmentPlanPhaseId ?? null,
          ehr_appointment_id: p.appointmentId ?? null,
          ehr_provider_id: p.providerId ?? null,
          ehr_location_id: p.locationId ?? null,
          procedure_code_id: p.procedureCodeId ?? null,
          tooth: p.tooth ?? null,
          surfaces: p.surfaces ?? null,
          patient_estimate: p.patientEstimate ?? null,
          insurance_estimate: p.insuranceEstimate ?? null,
          status_id: p.statusId ?? null,
          proposed_date: proposed,
          date_of_service: dateOfService,
          is_deleted: !!p.isDeleted,
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
        const totalValue = (p.patientEstimate ?? 0) + (p.insuranceEstimate ?? 0)

        if (p.statusId === PROC_STATUS_ACCEPTED && lastForwarded !== PROC_STATUS_ACCEPTED && !p.isDeleted) {
          await emitEvent(supabase, organizationId, patient.lead_id, 'lead.treatment_accepted', {
            ehr_source: 'carestack',
            ehr_procedure_id: p.id,
            ehr_patient_id: p.patientId,
            ehr_treatment_plan_id: p.treatmentPlanId,
            value: totalValue,
            currency: 'USD',
            patient_estimate: p.patientEstimate,
            insurance_estimate: p.insuranceEstimate,
            procedure_code_id: p.procedureCodeId,
            proposed_date: proposed,
          })
          events++
          await supabase
            .from('treatment_procedures')
            .update({ last_forwarded_status_id: PROC_STATUS_ACCEPTED, last_forwarded_at: new Date().toISOString() })
            .eq('id', procRowId)
        }

        if (p.statusId === PROC_STATUS_COMPLETED && lastForwarded !== PROC_STATUS_COMPLETED && !p.isDeleted) {
          await emitEvent(supabase, organizationId, patient.lead_id, 'lead.treatment_completed', {
            ehr_source: 'carestack',
            ehr_procedure_id: p.id,
            ehr_patient_id: p.patientId,
            value: totalValue,
            currency: 'USD',
            date_of_service: dateOfService,
            procedure_code_id: p.procedureCodeId,
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

type CareStackInvoiceRow = {
  InvoiceId: number
  Amount: number
  UnappliedAmount?: number
  ProviderId?: number
  LocationId?: number
  IsDeleted?: boolean
  PatientId?: number
  LastUpdatedOn?: string
  PaymentCategory?: string
  InvoiceNumber?: number
  PaymentDate?: string
  InvoiceType?: number
  InvoiceSource?: number
  PaymentTypeId?: number
  IsNsf?: boolean
}

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

      for (const inv of list) {
        const patient = inv.PatientId
          ? await ensurePatientStub(supabase, organizationId, inv.PatientId)
          : null

        const lastUpdated = inv.LastUpdatedOn ? new Date(inv.LastUpdatedOn).toISOString() : null
        if (lastUpdated && (!highWater || lastUpdated > highWater)) highWater = lastUpdated

        const baseRow = {
          organization_id: organizationId,
          patient_id: patient?.patient_row_id ?? null,
          ehr_invoice_id: inv.InvoiceId,
          ehr_invoice_number: inv.InvoiceNumber ?? null,
          ehr_source: 'carestack',
          amount: inv.Amount,
          unapplied_amount: inv.UnappliedAmount ?? null,
          ehr_provider_id: inv.ProviderId ?? null,
          ehr_location_id: inv.LocationId ?? null,
          payment_category: inv.PaymentCategory ?? null,
          invoice_type: inv.InvoiceType ?? null,
          invoice_source: inv.InvoiceSource ?? null,
          payment_type_id: inv.PaymentTypeId ?? null,
          payment_date: inv.PaymentDate ? new Date(inv.PaymentDate).toISOString() : null,
          is_nsf: !!inv.IsNsf,
          is_deleted: !!inv.IsDeleted,
          ehr_last_updated_on: lastUpdated,
        }

        const { data: existing } = await supabase
          .from('invoices')
          .select('id, forwarded')
          .eq('organization_id', organizationId)
          .eq('ehr_source', 'carestack')
          .eq('ehr_invoice_id', inv.InvoiceId)
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
        if (!alreadyForwarded && !inv.IsDeleted && !inv.IsNsf && inv.Amount > 0) {
          await emitEvent(supabase, organizationId, patient?.lead_id ?? null, 'lead.payment.received', {
            ehr_source: 'carestack',
            ehr_invoice_id: inv.InvoiceId,
            ehr_invoice_number: inv.InvoiceNumber,
            ehr_patient_id: inv.PatientId,
            value: inv.Amount,
            currency: 'USD',
            payment_category: inv.PaymentCategory,
            payment_date: inv.PaymentDate,
            invoice_type: inv.InvoiceType,
            invoice_source: inv.InvoiceSource,
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
