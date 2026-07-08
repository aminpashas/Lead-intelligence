import { describe, it, expect } from 'vitest'
import { suggestStageMove, type StageSuggestionInput } from '@/lib/pipeline/suggest-stage'
import type { PipelineStage } from '@/types/database'

const stage = (o: Partial<PipelineStage>): PipelineStage => ({
  id: '', organization_id: 'org', name: '', slug: '', description: null, color: '#000',
  position: 0, is_default: false, is_won: false, is_lost: false, auto_actions: [], created_at: '',
  ...o,
})

const STAGES: PipelineStage[] = [
  stage({ id: 'new', name: 'New', slug: 'new', position: 0 }),
  stage({ id: 'qual', name: 'Qualified', slug: 'qualified', position: 1 }),
  stage({ id: 'consult', name: 'Consultation', slug: 'consultation-scheduled', position: 2 }),
  stage({ id: 'nurture', name: 'Nurture', slug: 'nurture', position: 3 }),
  stage({ id: 'won', name: 'Won', slug: 'won', position: 4, is_won: true }),
]

const lead = (o: Partial<StageSuggestionInput> = {}): StageSuggestionInput => ({
  stage_id: 'new', status: 'new', consultation_date: null, ...o,
})

describe('suggestStageMove', () => {
  it('suggests the qualified stage for a high-probability early lead', () => {
    expect(suggestStageMove(lead(), 0.8, STAGES)).toMatchObject({ toStageId: 'qual', toStageName: 'Qualified' })
  })

  it('suggests the consultation stage when a consult is booked, regardless of probability', () => {
    expect(suggestStageMove(lead({ consultation_date: '2026-07-10T00:00:00Z' }), 0.2, STAGES))
      .toMatchObject({ toStageId: 'consult' })
  })

  it('suggests a nurture stage for a very low probability lead we have signal on', () => {
    expect(suggestStageMove(lead({ ai_qualification: 'cold' }), 0.05, STAGES))
      .toMatchObject({ toStageId: 'nurture' })
  })

  it('does NOT nurture a low-probability lead with no scoring or engagement signal', () => {
    // A never-scored, never-messaged import: its low score is missing data, not
    // low intent. Suggesting a move here is the "everything → Nurturing" bug.
    expect(suggestStageMove(lead(), 0.05, STAGES)).toBeNull()
  })

  it('never suggests moving a lead already in a won stage', () => {
    expect(suggestStageMove(lead({ stage_id: 'won' }), 0.9, STAGES)).toBeNull()
  })

  it('returns null when the lead is already in the target stage', () => {
    expect(suggestStageMove(lead({ stage_id: 'qual' }), 0.8, STAGES)).toBeNull()
  })

  it('returns null when no matching target stage exists', () => {
    const minimal = [stage({ id: 'new', name: 'New', slug: 'new', position: 0 })]
    expect(suggestStageMove(lead(), 0.8, minimal)).toBeNull()
  })
})
