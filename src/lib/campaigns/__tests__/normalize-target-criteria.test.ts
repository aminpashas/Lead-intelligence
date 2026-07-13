import { describe, it, expect } from 'vitest'
import { normalizeTargetCriteria } from '@/lib/campaigns/enrollments'

describe('normalizeTargetCriteria', () => {
  it('passes modern SmartListCriteria keys through untouched', () => {
    const criteria = {
      stages: ['stage-a', 'stage-b'],
      statuses: ['new', 'contacted'],
      tags: { ids: ['t1'], operator: 'or' as const },
      score_min: 40,
    }
    expect(normalizeTargetCriteria(criteria)).toEqual(criteria)
  })

  it('translates the legacy singular vocabulary to plural keys', () => {
    const out = normalizeTargetCriteria({
      status: ['new', 'contacted'],
      ai_qualification: ['hot', 'warm'],
      source_type: ['google_ads'],
      min_score: 30,
      max_score: 80,
    })
    expect(out).toEqual({
      statuses: ['new', 'contacted'],
      ai_qualifications: ['hot', 'warm'],
      source_types: ['google_ads'],
      score_min: 30,
      score_max: 80,
    })
  })

  it('prefers the modern key when both shapes are present', () => {
    const out = normalizeTargetCriteria({
      status: ['legacy'],
      statuses: ['modern'],
    })
    expect(out.statuses).toEqual(['modern'])
  })

  it('keeps stages when mixed with legacy status keys (the stage-picker case)', () => {
    const out = normalizeTargetCriteria({ stages: ['s1', 's2'], status: ['new'] })
    expect(out.stages).toEqual(['s1', 's2'])
    expect(out.statuses).toEqual(['new'])
  })

  it('maps the blueprint vocabulary (status_in → statuses, service_line passthrough)', () => {
    // The shape stored by the onboarding blueprint launch route.
    const out = normalizeTargetCriteria({ service_line: 'implants', status_in: ['new', 'contacted'] })
    expect(out).toEqual({ service_line: 'implants', statuses: ['new', 'contacted'] })
  })

  it('lets the modern statuses win over legacy status_in', () => {
    const out = normalizeTargetCriteria({ status_in: ['legacy'], statuses: ['modern'] })
    expect(out.statuses).toEqual(['modern'])
  })

  it('returns an empty object for empty input', () => {
    expect(normalizeTargetCriteria({})).toEqual({})
  })

  it('ignores legacy scalar filters that are not the expected type', () => {
    // A malformed value must not leak into the resolver as a bogus filter.
    const out = normalizeTargetCriteria({ status: 'new', min_score: '30' } as Record<string, unknown>)
    expect(out).toEqual({})
  })
})
