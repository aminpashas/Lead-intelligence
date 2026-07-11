import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DionEncounterBrief } from '@/lib/bridges/dion-clinical'
import type { DionConsumedEvent } from '@/lib/bridges/dion/consumed'

// Mock the Clinical pull + the trigger engine — the two side-effect dependencies
// of the landing orchestration. We drive everything else for real.
const fetchEncounterBrief = vi.fn<(...a: unknown[]) => unknown>()
const processTriggerCampaigns = vi.fn<(...a: unknown[]) => Promise<number>>(async () => 1)
vi.mock('@/lib/bridges/dion-clinical', () => ({ fetchEncounterBrief: (...a: unknown[]) => fetchEncounterBrief(...a) }))
vi.mock('@/lib/campaigns/triggers', () => ({ processTriggerCampaigns: (...a: unknown[]) => processTriggerCampaigns(...a) }))

import { handleEncounterSummarized } from '@/lib/bridges/dion-encounter-brief'

const scribeEvent: DionConsumedEvent = {
  id: 'evt-1',
  envelopeVersion: 1,
  source: 'dion-clinical',
  occurredAt: '2026-07-11T18:00:00.000Z',
  dionPracticeId: 'dprac-1',
  type: 'clinical.scribe_completed',
  data: { encounterId: 'enc-1', dionPatientId: 'dpat-1', noteId: 'note-1', durationSec: 300 },
}

const brief: DionEncounterBrief = {
  encounterId: 'enc-1',
  found: true,
  dionPatientId: 'dpat-1',
  externalCaseId: 'case-1',
  externalPlanId: 'plan-1',
  encounterStatus: 'completed',
  completedAt: '2026-07-11T18:00:00.000Z',
  note: { type: 'soap', status: 'final', signed: true, assessment: 'Full-arch candidate', plan: 'Present All-on-4; follow up on financing' },
  findings: [{ kind: 'unbilled', severity: 'watch' }],
}

/** Capturing supabase stub — records the writes the orchestration performs. */
function makeDb(opts: { orgId: string | null; caseRow?: { lead_id: string | null } | null; leadRow?: { id: string } | null }) {
  const calls: { briefUpsert?: Record<string, unknown>; leadUpdate?: Record<string, unknown>; activityInsert?: Record<string, unknown> } = {}
  const builder = (table: string) => {
    const b = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => {
        if (table === 'organizations') return { data: opts.orgId ? { id: opts.orgId } : null }
        if (table === 'clinical_cases') return { data: opts.caseRow ?? null }
        if (table === 'leads') return { data: opts.leadRow ?? null }
        return { data: null }
      },
      upsert: (payload: Record<string, unknown>) => { calls.briefUpsert = payload; return { error: null } },
      update: (payload: Record<string, unknown>) => { calls.leadUpdate = payload; return b },
      insert: async (payload: Record<string, unknown>) => { if (table === 'lead_activities') calls.activityInsert = payload; return { error: null } },
      // Awaiting the update chain (…update().eq().eq()) resolves here.
      then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
    }
    return b
  }
  const db = { from: (table: string) => builder(table) } as unknown as SupabaseClient
  return { db, calls }
}

describe('handleEncounterSummarized (orchestration)', () => {
  beforeEach(() => {
    fetchEncounterBrief.mockReset()
    processTriggerCampaigns.mockClear()
  })

  it('lands the brief on the case-linked lead and fires the trigger', async () => {
    fetchEncounterBrief.mockResolvedValue({ ok: true, found: true, brief })
    const { db, calls } = makeDb({ orgId: 'org-1', caseRow: { lead_id: 'lead-1' } })

    const outcome = await handleEncounterSummarized(db, scribeEvent)

    expect(outcome).toEqual({ status: 'landed', leadId: 'lead-1', encounterId: 'enc-1' })
    // Brief pull was scoped by the practice from the envelope.
    expect(fetchEncounterBrief).toHaveBeenCalledWith({ encounterId: 'enc-1', dionPracticeId: 'dprac-1' })
    // Brief row upserted with the summary + case bridge.
    expect(calls.briefUpsert?.encounter_id).toBe('enc-1')
    expect(calls.briefUpsert?.external_case_id).toBe('case-1')
    expect(String(calls.briefUpsert?.summary)).toContain('Assessment: Full-arch candidate')
    // Lead denormalized: summary + identity backfill.
    expect(String(calls.leadUpdate?.appointment_summary)).toContain('Plan: Present All-on-4')
    expect(calls.leadUpdate?.dion_patient_id).toBe('dpat-1')
    expect(calls.leadUpdate?.last_encounter_brief_at).toBeTruthy()
    // Automation + audit.
    expect(processTriggerCampaigns).toHaveBeenCalledWith(db, { event: 'encounter_summarized', lead_id: 'lead-1', organization_id: 'org-1' })
    expect(calls.activityInsert?.activity_type).toBe('encounter_summarized')
  })

  it('records the brief but does not fire when the lead is unmatched', async () => {
    fetchEncounterBrief.mockResolvedValue({ ok: true, found: true, brief: { ...brief, externalCaseId: null } })
    const { db, calls } = makeDb({ orgId: 'org-1', caseRow: null, leadRow: null })

    const outcome = await handleEncounterSummarized(db, scribeEvent)

    expect(outcome).toEqual({ status: 'unmatched_lead', encounterId: 'enc-1' })
    expect(calls.briefUpsert?.lead_id).toBeNull() // recorded for later reconciliation
    expect(processTriggerCampaigns).not.toHaveBeenCalled()
    expect(calls.leadUpdate).toBeUndefined()
  })

  it('throws on a transient pull failure so the receiver leaves it for reprocess', async () => {
    fetchEncounterBrief.mockResolvedValue({ ok: false, error: 'dion-clinical 500' })
    const { db } = makeDb({ orgId: 'org-1' })
    await expect(handleEncounterSummarized(db, scribeEvent)).rejects.toThrow(/500/)
  })

  it('no-ops when the practice does not map to an LI org', async () => {
    fetchEncounterBrief.mockResolvedValue({ ok: true, found: true, brief })
    const { db } = makeDb({ orgId: null })
    const outcome = await handleEncounterSummarized(db, scribeEvent)
    expect(outcome).toEqual({ status: 'org_not_found' })
    expect(fetchEncounterBrief).not.toHaveBeenCalled()
  })
})
