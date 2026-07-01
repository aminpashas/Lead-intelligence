import { describe, it, expect } from 'vitest'
import {
  resolveTechniqueEffectiveness,
  formatAssessmentForPrompt,
} from '@/lib/ai/technique-tracker'

describe('resolveTechniqueEffectiveness', () => {
  it('prefers the real outcome when present', () => {
    expect(
      resolveTechniqueEffectiveness({ technique_id: 't', predicted_effectiveness: 'effective', actual_effectiveness: 'backfired' })
    ).toEqual({ value: 'backfired', source: 'actual' })
  })

  it('falls back to the prediction when no outcome yet', () => {
    expect(
      resolveTechniqueEffectiveness({ technique_id: 't', predicted_effectiveness: 'effective', actual_effectiveness: null })
    ).toEqual({ value: 'effective', source: 'predicted' })
    expect(
      resolveTechniqueEffectiveness({ technique_id: 't', predicted_effectiveness: 'neutral' })
    ).toEqual({ value: 'neutral', source: 'predicted' })
  })

  it('treats an empty/whitespace outcome as absent', () => {
    expect(
      resolveTechniqueEffectiveness({ technique_id: 't', predicted_effectiveness: 'effective', actual_effectiveness: '  ' })
    ).toEqual({ value: 'effective', source: 'predicted' })
  })
})

describe('formatAssessmentForPrompt (outcome surfacing)', () => {
  it('labels real outcomes and adds the weighting note', () => {
    const out = formatAssessmentForPrompt(null, [
      { technique_id: 'closing_trial_close', predicted_effectiveness: 'effective', actual_effectiveness: 'backfired' },
    ])
    expect(out).toContain('real outcome')
    expect(out).toContain('weight these heavily')
    expect(out).toContain('backfired')
  })

  it('labels predictions as predicted and omits the note when no real outcomes', () => {
    const out = formatAssessmentForPrompt(null, [
      { technique_id: 'engagement_open_questions', predicted_effectiveness: 'effective', actual_effectiveness: null },
    ])
    expect(out).toContain('predicted')
    expect(out).not.toContain('weight these heavily')
  })
})
