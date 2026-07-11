import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildBriefSummary, resolveLeadForBrief } from '@/lib/bridges/dion-encounter-brief'
import { safeParseConsumedEvent } from '@/lib/bridges/dion/consumed'
import type { DionEncounterBrief } from '@/lib/bridges/dion-clinical'

function brief(overrides: Partial<DionEncounterBrief> = {}): DionEncounterBrief {
  return {
    encounterId: 'enc-1',
    found: true,
    dionPatientId: 'dpat-1',
    externalCaseId: null,
    externalPlanId: null,
    encounterStatus: 'completed',
    completedAt: '2026-07-11T18:00:00.000Z',
    note: { type: 'soap', status: 'draft', signed: false, assessment: null, plan: null },
    findings: [],
    ...overrides,
  }
}

describe('buildBriefSummary', () => {
  it('combines assessment + plan + finding flags', () => {
    const s = buildBriefSummary(
      brief({
        note: { type: 'soap', status: 'final', signed: true, assessment: 'Full-arch candidate', plan: 'Present All-on-4; follow up on financing' },
        findings: [{ kind: 'unbilled', severity: 'watch' }],
      }),
    )
    expect(s).toContain('Assessment: Full-arch candidate')
    expect(s).toContain('Plan: Present All-on-4; follow up on financing')
    expect(s).toContain('Flags: unbilled (watch)')
  })

  it('falls back to an outcome line when there is no note content', () => {
    expect(buildBriefSummary(brief({ note: null, encounterStatus: 'completed' }))).toMatch(/Visit completed/i)
  })

  it('does not leak empty sections', () => {
    const s = buildBriefSummary(brief({ note: { type: 'soap', status: 'draft', signed: false, assessment: 'Impression only', plan: null }, findings: [] }))
    expect(s).toBe('Assessment: Impression only')
  })
})

describe('resolveLeadForBrief', () => {
  // Minimal stub of the supabase query builder chain used by the resolver.
  function stub(tables: { clinical_cases?: { lead_id: string | null } | null; leads?: { id: string } | null }): SupabaseClient {
    const build = (row: unknown) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: row }),
      }
      return chain
    }
    return {
      from(table: string) {
        return build((table === 'clinical_cases' ? tables.clinical_cases : tables.leads) ?? null)
      },
    } as unknown as SupabaseClient
  }

  it('prefers externalCaseId → clinical_cases.lead_id', async () => {
    const db = stub({ clinical_cases: { lead_id: 'lead-from-case' }, leads: { id: 'lead-from-patient' } })
    const id = await resolveLeadForBrief(db, 'org-1', { externalCaseId: 'case-1', dionPatientId: 'dpat-1' })
    expect(id).toBe('lead-from-case')
  })

  it('falls back to dion_patient_id → leads when no case link', async () => {
    const db = stub({ clinical_cases: null, leads: { id: 'lead-from-patient' } })
    const id = await resolveLeadForBrief(db, 'org-1', { externalCaseId: null, dionPatientId: 'dpat-1' })
    expect(id).toBe('lead-from-patient')
  })

  it('returns null when unmatched', async () => {
    const db = stub({ clinical_cases: null, leads: null })
    const id = await resolveLeadForBrief(db, 'org-1', { externalCaseId: 'case-x', dionPatientId: 'dpat-x' })
    expect(id).toBeNull()
  })
})

describe('consumed catalog', () => {
  const envelope = {
    id: 'evt-1',
    envelopeVersion: 1 as const,
    source: 'dion-clinical',
    occurredAt: '2026-07-11T18:00:00.000Z',
    dionPracticeId: 'dprac-1',
  }

  it('accepts clinical.scribe_completed', () => {
    const r = safeParseConsumedEvent({
      ...envelope,
      type: 'clinical.scribe_completed',
      data: { encounterId: 'enc-1', dionPatientId: 'dpat-1', noteId: 'note-1', durationSec: 420 },
    })
    expect(r.success).toBe(true)
  })

  it('accepts clinical.encounter_completed', () => {
    const r = safeParseConsumedEvent({
      ...envelope,
      type: 'clinical.encounter_completed',
      data: { encounterId: 'enc-1', dionPatientId: 'dpat-1', providerId: 'prov-1', locationId: 'loc-1', procedureCount: 2, completedAt: '2026-07-11T18:00:00.000Z' },
    })
    expect(r.success).toBe(true)
  })

  it('rejects an event outside the consumed catalog (would 400)', () => {
    const r = safeParseConsumedEvent({ ...envelope, type: 'appointment.booked', data: { appointmentId: 'a-1' } })
    expect(r.success).toBe(false)
  })
})
