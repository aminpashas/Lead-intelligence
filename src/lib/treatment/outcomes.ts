/**
 * Post-treatment outcome capture.
 *
 * The single write path for public.treatment_outcomes. Recording an outcome does
 * three things atomically-enough for our purposes:
 *   1. inserts the outcome row,
 *   2. writes an immutable lead_activities trail entry,
 *   3. appends a `treatment.outcome_recorded` event for analytics.
 *
 * The event is stamped capi_status / gads_status = 'na' so the forward-events
 * connector pipeline ignores it — this is an internal clinical signal, not an
 * ad-platform conversion. (A value-adjusted offline conversion off the back of a
 * 'success' outcome is a deliberate follow-up, gated on the agent-attribution model.)
 *
 * Pass a service-role client: the function writes to events (service-role only).
 * Callers (the API route, future EHR sync) are responsible for authorizing the
 * actor and confirming the lead belongs to `organizationId` first.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type TreatmentOutcomeValue = 'success' | 'complication' | 'revision' | 'failure'

export type TreatmentOutcomeInput = {
  organizationId: string
  leadId: string
  outcome: TreatmentOutcomeValue
  treatmentClosingId?: string | null
  clinicalCaseId?: string | null
  satisfactionScore?: number | null
  followUpAttended?: boolean | null
  revisionRequired?: boolean
  finalRevenue?: number | null
  notes?: string | null
  recordedBy?: string | null
  /** When the outcome occurred/was observed. Defaults to now. */
  occurredAt?: string
}

export async function recordTreatmentOutcome(
  supabase: SupabaseClient,
  input: TreatmentOutcomeInput
): Promise<{ id: string }> {
  const occurredAt = input.occurredAt ?? new Date().toISOString()

  const { data: row, error } = await supabase
    .from('treatment_outcomes')
    .insert({
      organization_id: input.organizationId,
      lead_id: input.leadId,
      treatment_closing_id: input.treatmentClosingId ?? null,
      clinical_case_id: input.clinicalCaseId ?? null,
      outcome: input.outcome,
      satisfaction_score: input.satisfactionScore ?? null,
      follow_up_attended: input.followUpAttended ?? null,
      revision_required: input.revisionRequired ?? false,
      final_revenue: input.finalRevenue ?? null,
      notes: input.notes ?? null,
      recorded_by: input.recordedBy ?? null,
      occurred_at: occurredAt,
    })
    .select('id')
    .single()

  if (error || !row) {
    throw new Error(`recordTreatmentOutcome insert failed: ${error?.message ?? 'no row returned'}`)
  }

  // Immutable activity trail on the lead. Best-effort: a failed trail/event write
  // must not roll back the recorded outcome, so we don't throw on these.
  const summary = {
    outcome: input.outcome,
    satisfaction_score: input.satisfactionScore ?? null,
    revision_required: input.revisionRequired ?? false,
    final_revenue: input.finalRevenue ?? null,
  }

  await supabase
    .from('lead_activities')
    .insert({
      lead_id: input.leadId,
      organization_id: input.organizationId,
      activity_type: 'treatment_outcome_recorded',
      title: `Treatment outcome: ${input.outcome}`,
      description: input.notes ?? null,
      user_id: input.recordedBy ?? null,
      metadata: summary,
    })
    .then(({ error: actErr }) => {
      if (actErr) console.warn('[treatment-outcome] activity write failed', actErr.message)
    })

  await supabase
    .from('events')
    .insert({
      organization_id: input.organizationId,
      lead_id: input.leadId,
      event_type: 'treatment.outcome_recorded',
      payload: {
        ...summary,
        treatment_closing_id: input.treatmentClosingId ?? null,
        clinical_case_id: input.clinicalCaseId ?? null,
      },
      // 'na' → forward-events leaves it alone; this is an internal signal.
      capi_status: 'na',
      gads_status: 'na',
      occurred_at: occurredAt,
    })
    .then(({ error: evtErr }) => {
      if (evtErr) console.warn('[treatment-outcome] event write failed', evtErr.message)
    })

  return { id: row.id }
}
