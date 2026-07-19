/**
 * Inbound counterpart to dion-clinical.ts: land a Dion Clinical encounter brief
 * onto the matching lead so the closer agent + closing board can act on the
 * visit outcome.
 *
 * Flow (driven by /api/bus/receive on clinical.scribe_completed / .encounter_completed):
 *   1. envelope.dionPracticeId → LI organizations.id
 *   2. pull the curated brief from Dion Clinical (READ arm — carries the note gist)
 *   3. resolve the lead:  brief.externalCaseId → clinical_cases.lead_id  (primary),
 *      else brief.dionPatientId → leads.dion_patient_id  (consult-only fallback)
 *   4. upsert lead_encounter_briefs; land summary on the lead; backfill the
 *      dion_patient_id identity link; fire the encounter_summarized trigger; log.
 *
 * PHI: brief.summary is INTERNAL clinical narrative — it lands on the lead to
 * STEER follow-ups; the closer agent gates disclosure to the patient.
 * Never throws for "not found / not matched" (returns a status); DOES throw on a
 * transient pull/DB failure so the receiver leaves the event unprocessed for retry.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEncounterBrief, type DionEncounterBrief } from './dion-clinical'
import { processTriggerCampaigns } from '@/lib/campaigns/triggers'
import type { DionClinicalEvent } from './dion/clinical'

export type EncounterBriefOutcome =
  | { status: 'landed'; leadId: string; encounterId: string }
  | { status: 'unmatched_lead'; encounterId: string }
  | { status: 'skipped' | 'not_found' | 'no_practice' | 'org_not_found' }

/** Assemble the INTERNAL follow-up summary from a curated brief. Pure. */
export function buildBriefSummary(brief: DionEncounterBrief): string {
  const parts: string[] = []
  if (brief.note?.assessment) parts.push(`Assessment: ${brief.note.assessment.trim()}`)
  if (brief.note?.plan) parts.push(`Plan: ${brief.note.plan.trim()}`)
  if (brief.findings.length > 0) {
    const flags = brief.findings.map((f) => `${f.kind} (${f.severity})`).join(', ')
    parts.push(`Flags: ${flags}`)
  }
  if (parts.length === 0) {
    // No note yet (e.g. encounter_completed with no scribe) — record the outcome.
    return brief.encounterStatus ? `Visit ${brief.encounterStatus} — no clinical note yet.` : 'Visit recorded.'
  }
  return parts.join('\n')
}

/** Resolve the LI lead a brief belongs to. Pure w.r.t. inputs; issues scoped
 * reads. externalCaseId (LI clinical_cases.id) is the primary bridge; the
 * dion_patient_id link is the consult-only fallback. Returns null if unmatched. */
export async function resolveLeadForBrief(
  supabase: SupabaseClient,
  orgId: string,
  brief: Pick<DionEncounterBrief, 'externalCaseId' | 'dionPatientId'>,
): Promise<string | null> {
  if (brief.externalCaseId) {
    const { data: kase } = await supabase
      .from('clinical_cases')
      .select('lead_id')
      .eq('organization_id', orgId)
      .eq('id', brief.externalCaseId)
      .maybeSingle()
    if (kase?.lead_id) return kase.lead_id as string
  }
  if (brief.dionPatientId) {
    const { data: lead } = await supabase
      .from('leads')
      .select('id')
      .eq('organization_id', orgId)
      .eq('dion_patient_id', brief.dionPatientId)
      .maybeSingle()
    if (lead?.id) return lead.id as string
  }
  return null
}

export async function handleEncounterSummarized(
  supabase: SupabaseClient,
  event: DionClinicalEvent,
): Promise<EncounterBriefOutcome> {
  const dionPracticeId = event.dionPracticeId
  if (!dionPracticeId) return { status: 'no_practice' }

  const { data: org } = await supabase
    .from('organizations')
    .select('id')
    .eq('dion_practice_id', dionPracticeId)
    .maybeSingle()
  if (!org) return { status: 'org_not_found' }
  const orgId = org.id as string

  const encounterId = event.data.encounterId
  const res = await fetchEncounterBrief({ encounterId, dionPracticeId })
  if (res.skipped) return { status: 'skipped' }
  if (!res.ok) throw new Error(res.error ?? 'brief pull failed') // retry-able
  if (!res.found || !res.brief) return { status: 'not_found' }

  const brief = res.brief
  const leadId = await resolveLeadForBrief(supabase, orgId, brief)
  const summary = buildBriefSummary(brief)
  const now = new Date().toISOString()

  const { error: briefErr } = await supabase.from('lead_encounter_briefs').upsert(
    {
      organization_id: orgId,
      lead_id: leadId,
      encounter_id: encounterId,
      dion_patient_id: brief.dionPatientId,
      external_case_id: brief.externalCaseId,
      encounter_status: brief.encounterStatus,
      note_status: brief.note?.status ?? null,
      outcome: brief.note ? 'summarized' : brief.encounterStatus,
      summary,
      findings: brief.findings,
      updated_at: now,
    },
    { onConflict: 'organization_id,encounter_id' },
  )
  if (briefErr) throw new Error(briefErr.message)

  if (!leadId) return { status: 'unmatched_lead', encounterId }

  const { error: leadErr } = await supabase
    .from('leads')
    .update({
      appointment_summary: summary,
      last_encounter_brief_at: now,
      // Backfill the identity link so a later consult-only encounter resolves.
      ...(brief.dionPatientId ? { dion_patient_id: brief.dionPatientId } : {}),
    })
    .eq('id', leadId)
    .eq('organization_id', orgId)
  if (leadErr) throw new Error(leadErr.message)

  // Automation hook: orgs configure a trigger campaign on this event to nudge.
  await processTriggerCampaigns(supabase, {
    event: 'encounter_summarized',
    lead_id: leadId,
    organization_id: orgId,
  })

  await supabase.from('lead_activities').insert({
    organization_id: orgId,
    lead_id: leadId,
    activity_type: 'encounter_summarized',
    title: 'Visit summary received from Dion Clinical',
    metadata: {
      encounter_id: encounterId,
      external_case_id: brief.externalCaseId,
      note_status: brief.note?.status ?? null,
      finding_count: brief.findings.length,
    },
  })

  return { status: 'landed', leadId, encounterId }
}
