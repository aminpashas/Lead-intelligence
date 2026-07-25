/**
 * Lead outcome rollup — the "last mile" of the EHR closed loop.
 *
 * The sync writes `treatment_procedures` / `ehr_appointments` rows and emits
 * per-status events, but the entire downstream — Google/Meta offline conversions,
 * GA4, Slack, and every dashboard in `goals/actuals.ts` — reads the value off the
 * LEAD:
 *   leads.treatment_value   (accepted case value)
 *   leads.actual_revenue    (delivered/collected)
 *   leads.converted_at      (became a paying case)
 *
 * Idempotent: only writes when a computed value actually differs from what's
 * stored, so it's safe to run on every sync + as a one-off backfill.
 *
 * Vendor-neutral. It reads the `ehr_*` tables, which have always carried an
 * `ehr_source` discriminator, and asks that source's adapter to translate its
 * status codes into our vocabulary (see lib/ehr/port.ts). Rows from an EMR with
 * no registered adapter are skipped rather than silently miscounted.
 *
 * Value semantics:
 *   treatment_value = Σ(patient_estimate + insurance_estimate) for accepted OR completed
 *   actual_revenue  = Σ(patient_estimate + insurance_estimate) for completed only
 *   converted_at    = earliest (date_of_service ?? proposed_date) among those
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { moveLeadToNoShowStage } from '@/lib/pipeline/no-show-stage'
import { getAdapter } from './registry'
import type { NormalizedProcedureStatus, NormalizedApptOutcome } from './port'

/**
 * Lead statuses we're allowed to advance from. A lead further along (or terminal:
 * scheduled/in_treatment/completed/lost/disqualified/no_show) is left as-is so the
 * rollup never regresses a hand-set or downstream stage.
 */
const EARLY_STATUSES = new Set<string | null>([
  null, 'new', 'contacted', 'qualified', 'consultation_scheduled',
  'consultation_completed', 'treatment_presented', 'financing',
  'unresponsive', 'dormant',
])

/** One procedure row, trimmed to the fields the rollup needs, already normalized. */
export type ProcedureForRollup = {
  status: NormalizedProcedureStatus
  patient_estimate: number | null
  insurance_estimate: number | null
  date_of_service: string | null
  proposed_date: string | null
}

export type LeadOutcome = {
  treatment_value: number
  actual_revenue: number
  converted_at: string | null
}

/**
 * Pure aggregation — turn a lead's procedures into the outcome columns.
 * Exported for unit testing; no I/O.
 */
export function computeLeadOutcome(procedures: ProcedureForRollup[]): LeadOutcome {
  let treatmentValue = 0
  let actualRevenue = 0
  let convertedAt: string | null = null

  for (const p of procedures) {
    if (p.status !== 'accepted' && p.status !== 'completed') continue

    const value = (p.patient_estimate ?? 0) + (p.insurance_estimate ?? 0)
    treatmentValue += value
    if (p.status === 'completed') actualRevenue += value

    const when = p.date_of_service ?? p.proposed_date
    if (when && (convertedAt === null || when < convertedAt)) convertedAt = when
  }

  return {
    treatment_value: round2(treatmentValue),
    actual_revenue: round2(actualRevenue),
    converted_at: convertedAt,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Translate a raw vendor status via that row's adapter. Rows from a source with
 * no registered adapter return null and are dropped by the caller — better to
 * under-count than to guess another vendor's enum.
 */
function normalizeProcedure(source: unknown, statusId: unknown): NormalizedProcedureStatus | null {
  const adapter = getAdapter(source)
  return adapter ? adapter.normalizeProcedureStatus(statusId) : null
}

function normalizeAppointment(source: unknown, status: unknown): NormalizedApptOutcome | null {
  const adapter = getAdapter(source)
  return adapter ? adapter.normalizeAppointmentStatus(status) : null
}

export type RollupResult = {
  resource: 'lead_revenue_rollup'
  status: 'success' | 'partial' | 'failed'
  leads_examined: number
  leads_updated: number
  leads_failed?: number
  total_treatment_value: number
  total_actual_revenue: number
  dry_run: boolean
  /** Present only in dry-run: what would change, so a human can eyeball it. */
  preview?: Array<{ lead_id: string; from: Partial<LeadOutcome>; to: LeadOutcome }>
  error?: string
}

/**
 * Roll accepted/completed procedure dollars up onto the matched leads for one org,
 * across every EMR the org has synced.
 *
 * @param dryRun when true, computes and returns the planned changes but writes nothing.
 */
export async function rollupLeadOutcomes(
  supabase: SupabaseClient,
  organizationId: string,
  opts: { dryRun?: boolean } = {}
): Promise<RollupResult> {
  const dryRun = !!opts.dryRun
  try {
    // 1. Map lead-linked patients → lead_id (paged; the roster can be large).
    const patientToLead = new Map<string, string>()
    const leadIds = new Set<string>()
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('patients')
        .select('id, lead_id')
        .eq('organization_id', organizationId)
        .not('lead_id', 'is', null)
        .range(from, from + 999)
      if (error) throw new Error(`patients read failed: ${error.message}`)
      if (!data || data.length === 0) break
      for (const row of data) {
        patientToLead.set(row.id as string, row.lead_id as string)
        leadIds.add(row.lead_id as string)
      }
      if (data.length < 1000) break
    }

    if (patientToLead.size === 0) {
      return emptyResult(dryRun)
    }

    // 2. Page through the org's (non-deleted) procedures, keeping only those
    //    whose patient is lead-linked, bucketed by lead. Paging the full set is
    //    cheaper + safer than a huge patient_id IN() clause (URL-length limits).
    const byLead = new Map<string, ProcedureForRollup[]>()
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('treatment_procedures')
        .select('patient_id, ehr_source, status_id, patient_estimate, insurance_estimate, date_of_service, proposed_date')
        .eq('organization_id', organizationId)
        .eq('is_deleted', false)
        .range(from, from + 999)
      if (error) throw new Error(`procedures read failed: ${error.message}`)
      if (!data || data.length === 0) break
      for (const row of data) {
        const leadId = patientToLead.get(row.patient_id as string)
        if (!leadId) continue
        const status = normalizeProcedure(row.ehr_source, row.status_id)
        if (!status) continue
        const list = byLead.get(leadId) ?? []
        list.push({
          status,
          patient_estimate: (row.patient_estimate as number) ?? null,
          insurance_estimate: (row.insurance_estimate as number) ?? null,
          date_of_service: (row.date_of_service as string) ?? null,
          proposed_date: (row.proposed_date as string) ?? null,
        })
        byLead.set(leadId, list)
      }
      if (data.length < 1000) break
    }

    // 3. Read current lead values so we only write real changes.
    const current = new Map<string, LeadOutcome & { status: string | null }>()
    const allLeadIds = [...leadIds]
    for (let i = 0; i < allLeadIds.length; i += 100) {
      const chunk = allLeadIds.slice(i, i + 100)
      const { data, error } = await supabase
        .from('leads')
        .select('id, treatment_value, actual_revenue, converted_at, status')
        .in('id', chunk)
      if (error) throw new Error(`leads read failed: ${error.message}`)
      for (const row of data ?? []) {
        current.set(row.id as string, {
          treatment_value: (row.treatment_value as number) ?? 0,
          actual_revenue: (row.actual_revenue as number) ?? 0,
          converted_at: (row.converted_at as string) ?? null,
          status: (row.status as string) ?? null,
        })
      }
    }

    // 4. Compute + write (or preview).
    let updated = 0
    let failed = 0
    let totalTreatment = 0
    let totalActual = 0
    const preview: RollupResult['preview'] = []

    for (const [leadId, procs] of byLead) {
      const outcome = computeLeadOutcome(procs)
      if (outcome.treatment_value === 0 && outcome.actual_revenue === 0) continue

      totalTreatment += outcome.treatment_value
      totalActual += outcome.actual_revenue

      const cur = current.get(leadId)
      const changed =
        !cur ||
        cur.treatment_value !== outcome.treatment_value ||
        cur.actual_revenue !== outcome.actual_revenue ||
        cur.converted_at !== outcome.converted_at
      if (!changed) continue

      if (dryRun) {
        updated++
        preview.push({
          lead_id: leadId,
          from: cur ? { treatment_value: cur.treatment_value, actual_revenue: cur.actual_revenue, converted_at: cur.converted_at } : {},
          to: outcome,
        })
        continue
      }

      const patch: Record<string, unknown> = {
        treatment_value: outcome.treatment_value,
        actual_revenue: outcome.actual_revenue,
      }
      // Only advance converted_at (never clobber an earlier real conversion date).
      if (outcome.converted_at && (!cur?.converted_at || outcome.converted_at < cur.converted_at)) {
        patch.converted_at = outcome.converted_at
      }
      // Promote status to reflect the real outcome, but only from an early stage
      // (never regress a further-along or terminal status). completed = delivered,
      // contract_signed = accepted-but-not-yet-delivered.
      if (EARLY_STATUSES.has(cur?.status ?? null)) {
        patch.status = outcome.actual_revenue > 0 ? 'completed' : 'contract_signed'
      }

      const { error } = await supabase.from('leads').update(patch).eq('id', leadId)
      if (error) {
        // One bad row must not abort the whole backfill.
        failed++
        continue
      }
      updated++
    }

    return {
      resource: 'lead_revenue_rollup',
      status: failed > 0 ? 'partial' : 'success',
      leads_examined: byLead.size,
      leads_updated: updated,
      leads_failed: failed,
      total_treatment_value: round2(totalTreatment),
      total_actual_revenue: round2(totalActual),
      dry_run: dryRun,
      ...(dryRun ? { preview } : {}),
    }
  } catch (e) {
    return {
      resource: 'lead_revenue_rollup',
      status: 'failed',
      leads_examined: 0,
      leads_updated: 0,
      total_treatment_value: 0,
      total_actual_revenue: 0,
      dry_run: dryRun,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

// ── Consult rollup (appointments → lead show / no-show / consult dates) ──────

export type AppointmentForConsult = {
  outcome: NormalizedApptOutcome
  start_at: string | null
}

export type ConsultOutcome = {
  consultation_date: string | null    // earliest kept/booked visit
  consult_completed_at: string | null // earliest visit they actually showed for
  no_show_count: number
}

/**
 * Pure aggregation — a lead's appointments → consult outcome columns.
 * Exported for tests; no I/O.
 */
export function computeConsultOutcome(appts: AppointmentForConsult[]): ConsultOutcome {
  let consultationDate: string | null = null
  let consultCompletedAt: string | null = null
  let noShow = 0

  for (const a of appts) {
    if (a.outcome === 'ignored' || a.outcome === 'cancelled') continue
    if (a.outcome === 'no_show') { noShow++; continue }

    const when = a.start_at
    if (when && (consultationDate === null || when < consultationDate)) consultationDate = when
    if (a.outcome === 'completed' && when && (consultCompletedAt === null || when < consultCompletedAt)) {
      consultCompletedAt = when
    }
  }

  return { consultation_date: consultationDate, consult_completed_at: consultCompletedAt, no_show_count: noShow }
}

export type ConsultRollupResult = {
  resource: 'lead_consult_rollup'
  status: 'success' | 'partial' | 'failed'
  leads_examined: number
  leads_updated: number
  leads_failed?: number
  dry_run: boolean
  error?: string
}

/**
 * Roll appointment outcomes onto the matched leads: sets consultation_date /
 * consult_completed_at / no_show_count so the dashboards' consult + show-rate
 * metrics stop reading null. Idempotent.
 */
export async function rollupConsultOutcomes(
  supabase: SupabaseClient,
  organizationId: string,
  opts: { dryRun?: boolean } = {}
): Promise<ConsultRollupResult> {
  const dryRun = !!opts.dryRun
  try {
    // 1. patient → lead map (lead-linked only).
    const patientToLead = new Map<string, string>()
    const leadIds = new Set<string>()
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('patients')
        .select('id, lead_id')
        .eq('organization_id', organizationId)
        .not('lead_id', 'is', null)
        .range(from, from + 999)
      if (error) throw new Error(`patients read failed: ${error.message}`)
      if (!data || data.length === 0) break
      for (const row of data) {
        patientToLead.set(row.id as string, row.lead_id as string)
        leadIds.add(row.lead_id as string)
      }
      if (data.length < 1000) break
    }
    if (patientToLead.size === 0) {
      return { resource: 'lead_consult_rollup', status: 'success', leads_examined: 0, leads_updated: 0, dry_run: dryRun }
    }

    // 2. Page appointments, bucket by lead.
    const byLead = new Map<string, AppointmentForConsult[]>()
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('ehr_appointments')
        .select('patient_id, ehr_source, status, start_at')
        .eq('organization_id', organizationId)
        .range(from, from + 999)
      if (error) throw new Error(`appointments read failed: ${error.message}`)
      if (!data || data.length === 0) break
      for (const row of data) {
        const leadId = row.patient_id ? patientToLead.get(row.patient_id as string) : undefined
        if (!leadId) continue
        const outcome = normalizeAppointment(row.ehr_source, row.status)
        if (!outcome) continue
        const list = byLead.get(leadId) ?? []
        list.push({ outcome, start_at: (row.start_at as string) ?? null })
        byLead.set(leadId, list)
      }
      if (data.length < 1000) break
    }

    // 3. Current lead consult values (write only real changes).
    const current = new Map<string, { consultation_date: string | null; consult_completed_at: string | null; no_show_count: number; status: string | null }>()
    const allLeadIds = [...leadIds]
    for (let i = 0; i < allLeadIds.length; i += 100) {
      const chunk = allLeadIds.slice(i, i + 100)
      const { data, error } = await supabase
        .from('leads')
        .select('id, consultation_date, consult_completed_at, no_show_count, status')
        .in('id', chunk)
      if (error) throw new Error(`leads read failed: ${error.message}`)
      for (const row of data ?? []) {
        current.set(row.id as string, {
          consultation_date: (row.consultation_date as string) ?? null,
          consult_completed_at: (row.consult_completed_at as string) ?? null,
          no_show_count: (row.no_show_count as number) ?? 0,
          status: (row.status as string) ?? null,
        })
      }
    }

    let updated = 0
    let failed = 0
    for (const [leadId, appts] of byLead) {
      const outcome = computeConsultOutcome(appts)
      if (!outcome.consultation_date && !outcome.consult_completed_at && outcome.no_show_count === 0) continue

      const cur = current.get(leadId)
      const changed =
        !cur ||
        cur.consultation_date !== outcome.consultation_date ||
        cur.consult_completed_at !== outcome.consult_completed_at ||
        cur.no_show_count !== outcome.no_show_count
      if (!changed) continue

      if (dryRun) { updated++; continue }

      const patch: Record<string, unknown> = { no_show_count: outcome.no_show_count }
      if (outcome.consultation_date && (!cur?.consultation_date || outcome.consultation_date < cur.consultation_date)) {
        patch.consultation_date = outcome.consultation_date
      }
      if (outcome.consult_completed_at && (!cur?.consult_completed_at || outcome.consult_completed_at < cur.consult_completed_at)) {
        patch.consult_completed_at = outcome.consult_completed_at
      }
      // Advance status from an early stage to reflect the real consult outcome.
      if (EARLY_STATUSES.has(cur?.status ?? null)) {
        if (outcome.consult_completed_at) patch.status = 'consultation_completed'
        else if (outcome.no_show_count > 0) patch.status = 'no_show'
        else if (outcome.consultation_date) patch.status = 'consultation_scheduled'
      }

      const { error } = await supabase.from('leads').update(patch).eq('id', leadId)
      if (error) { failed++; continue }
      updated++

      // Board sync for EHR-detected no-shows, so a card the practice can see
      // matches what the PMS already knows. Gated on this rollup being the
      // thing that just flipped the status, which bounds it to real transitions
      // instead of re-moving every historical no-show on every run.
      //
      // Deliberately NO recovery enrollment here: this pass reconciles the full
      // appointment history, and the sequence opens with a same-day "we missed
      // you today" SMS. Enrolling from a backfill would text patients about
      // consultations they missed months ago. Real-time no-shows enroll at their
      // own write paths (the staff PATCH in api/appointments).
      if (patch.status === 'no_show') {
        await moveLeadToNoShowStage(supabase, {
          organizationId,
          leadId,
          source: 'no_show:ehr_rollup',
        })
      }
    }

    return {
      resource: 'lead_consult_rollup',
      status: failed > 0 ? 'partial' : 'success',
      leads_examined: byLead.size,
      leads_updated: updated,
      leads_failed: failed,
      dry_run: dryRun,
    }
  } catch (e) {
    return {
      resource: 'lead_consult_rollup',
      status: 'failed',
      leads_examined: 0,
      leads_updated: 0,
      dry_run: dryRun,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

function emptyResult(dryRun: boolean): RollupResult {
  return {
    resource: 'lead_revenue_rollup',
    status: 'success',
    leads_examined: 0,
    leads_updated: 0,
    total_treatment_value: 0,
    total_actual_revenue: 0,
    dry_run: dryRun,
    ...(dryRun ? { preview: [] } : {}),
  }
}
