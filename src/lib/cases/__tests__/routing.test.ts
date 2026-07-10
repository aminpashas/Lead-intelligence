import { describe, it, expect } from 'vitest'
import { deriveLabRouting, deriveSurgeryRouting } from '@/lib/cases/routing'
import type { ClinicalCase } from '@/types/database'

// Minimal case factory — only the fields the routing derivation reads.
function makeCase(overrides: Partial<ClinicalCase> = {}): ClinicalCase {
  return {
    id: 'c1', organization_id: 'o1', lead_id: null,
    patient_name: 'Jane Doe', patient_email: null, patient_phone: null,
    case_number: 'CASE-1', chief_complaint: 'x', clinical_notes: null,
    status: 'intake', priority: 'normal', created_by: 'u1', assigned_doctor_id: null,
    ai_analysis_summary: null, ai_analyzed_at: null, share_token: 't',
    patient_notified_at: null, patient_viewed_at: null, patient_accepted_at: null,
    diagnosed_at: null, treatment_planned_at: null, completed_at: null,
    created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  } as ClinicalCase
}

describe('deriveLabRouting', () => {
  it('is inactive with no lab order', () => {
    const r = deriveLabRouting(makeCase())
    expect(r.active).toBe(false)
    expect(r.state).toBe('not_sent')
    expect(r.deepLink).toBeNull()
  })

  it('maps SDL statuses to coarse states', () => {
    const cases: Array<[ClinicalCase['lab_order'], string]> = [
      [{ id: 'l', lab_provider: 'smile_design_lab', status: 'submitted', external_case_id: 'x', external_case_number: 'SDL-1', submitted_at: null, updated_at: '' }, 'submitted'],
      [{ id: 'l', lab_provider: 'smile_design_lab', status: 'manufacturing', external_case_id: 'x', external_case_number: 'SDL-1', submitted_at: null, updated_at: '' }, 'in_production'],
      [{ id: 'l', lab_provider: 'smile_design_lab', status: 'delivered', external_case_id: 'x', external_case_number: 'SDL-1', submitted_at: null, updated_at: '' }, 'delivered'],
      [{ id: 'l', lab_provider: 'smile_design_lab', status: 'error', external_case_id: 'x', external_case_number: 'SDL-1', submitted_at: null, updated_at: '' }, 'issue'],
    ]
    for (const [order, expected] of cases) {
      expect(deriveLabRouting(makeCase({ lab_order: order })).state).toBe(expected)
    }
  })

  it('builds the SDL doctor deep link when the web base + external id are known', () => {
    const r = deriveLabRouting(
      makeCase({ lab_order: { id: 'l', lab_provider: 'smile_design_lab', status: 'submitted', external_case_id: 'sdl-uuid', external_case_number: 'SDL-2026-000123', submitted_at: null, updated_at: '' } }),
      'https://sdl.example.app/',
    )
    expect(r.deepLink).toBe('https://sdl.example.app/doctor/cases/sdl-uuid')
    expect(r.externalNumber).toBe('SDL-2026-000123')
  })

  it('omits the deep link without a web base', () => {
    const r = deriveLabRouting(
      makeCase({ lab_order: { id: 'l', lab_provider: 'smile_design_lab', status: 'submitted', external_case_id: 'sdl-uuid', external_case_number: 'SDL-2026-000123', submitted_at: null, updated_at: '' } }),
    )
    expect(r.deepLink).toBeNull()
  })
})

describe('deriveSurgeryRouting', () => {
  const closingBase = {
    id: 'cl', current_step: 'contract_signed' as const, steps_completed: [],
    contract_signed_at: null, contract_amount: null, financing_type: null,
    financing_funded_at: null, consent_signed_at: null, preop_instructions_sent_at: null,
    surgery_date: null, surgery_time: null, records_checklist: {} as never, records_confirmed_at: null,
    dion_handoff_at: null, dion_surgery_status: null, dion_surgery_date: null, dion_synced_at: null,
  }

  it('is not routed when nothing has happened', () => {
    expect(deriveSurgeryRouting(makeCase()).state).toBe('not_routed')
  })

  it('reads handed_off from a delivered federation hand-off', () => {
    const r = deriveSurgeryRouting(makeCase({ status: 'accepted', closing: { ...closingBase, dion_handoff_at: '2026-07-05T00:00:00Z' } }))
    expect(r.state).toBe('handed_off')
    expect(r.active).toBe(true)
  })

  it('prefers scheduled over handed_off, and surfaces the date', () => {
    const r = deriveSurgeryRouting(makeCase({ status: 'accepted', closing: { ...closingBase, dion_handoff_at: '2026-07-05T00:00:00Z', dion_surgery_status: 'scheduled', dion_surgery_date: '2026-08-01' } }))
    expect(r.state).toBe('scheduled')
    expect(r.date).toBe('2026-08-01')
  })

  it('treats an LI closing surgery_date as scheduled even before Dion read-back', () => {
    expect(deriveSurgeryRouting(makeCase({ status: 'accepted', closing: { ...closingBase, surgery_date: '2026-08-01' } })).state).toBe('scheduled')
  })

  it('completed wins over everything', () => {
    const r = deriveSurgeryRouting(makeCase({ status: 'completed', closing: { ...closingBase, dion_handoff_at: '2026-07-05T00:00:00Z', surgery_date: '2026-08-01' } }))
    expect(r.state).toBe('completed')
  })
})
