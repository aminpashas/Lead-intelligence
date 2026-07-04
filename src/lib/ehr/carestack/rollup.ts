/**
 * Lead revenue rollup — the "last mile" of the CareStack closed loop.
 *
 * The sync writes `treatment_procedures` rows and emits per-status events, but
 * the entire downstream — Google/Meta offline conversions, GA4, Slack, and every
 * dashboard in `goals/actuals.ts` — reads the value off the LEAD:
 *   leads.treatment_value   (accepted case value)
 *   leads.actual_revenue    (delivered/collected)
 *   leads.converted_at      (became a paying case)
 *
 * Nothing populated those columns, so dashboards showed $0 and conversions
 * shipped to the ad platforms with a blank value. This module aggregates each
 * lead-linked patient's procedures and stamps the summary back onto the lead.
 *
 * Idempotent: only writes when a computed value actually differs from what's
 * stored, so it's safe to run on every sync + as a one-off backfill.
 *
 * Value semantics (CareStack procedure status enum):
 *   3 = Accepted, 8 = Completed.
 *   treatment_value = Σ(patient_estimate + insurance_estimate) for Accepted OR Completed
 *   actual_revenue  = Σ(patient_estimate + insurance_estimate) for Completed only
 *   converted_at    = earliest (date_of_service ?? proposed_date) among Accepted/Completed
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const PROC_STATUS_ACCEPTED = 3
export const PROC_STATUS_COMPLETED = 8

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

/** One procedure row, trimmed to the fields the rollup needs. */
export type ProcedureForRollup = {
  status_id: number | null
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
    const status = p.status_id
    if (status !== PROC_STATUS_ACCEPTED && status !== PROC_STATUS_COMPLETED) continue

    const value = (p.patient_estimate ?? 0) + (p.insurance_estimate ?? 0)
    treatmentValue += value
    if (status === PROC_STATUS_COMPLETED) actualRevenue += value

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
 * Roll CareStack procedure dollars up onto the matched leads for one org.
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
        .select('patient_id, status_id, patient_estimate, insurance_estimate, date_of_service, proposed_date')
        .eq('organization_id', organizationId)
        .eq('is_deleted', false)
        .range(from, from + 999)
      if (error) throw new Error(`procedures read failed: ${error.message}`)
      if (!data || data.length === 0) break
      for (const row of data) {
        const leadId = patientToLead.get(row.patient_id as string)
        if (!leadId) continue
        const list = byLead.get(leadId) ?? []
        list.push(row as ProcedureForRollup)
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
