import { describe, it, expect } from 'vitest'
import {
  buildManualCallRows,
  buildLeadCapturePatch,
  type ManualCallInput,
} from '@/lib/timeline/manual-call'

const base: ManualCallInput = {
  orgId: 'org-1', leadId: 'lead-1', userId: 'user-1',
  direction: 'outbound', outcome: 'interested', durationSeconds: 90,
  notes: 'Discussed financing', testimonialSent: false,
  nowIso: '2026-07-01T15:00:00.000Z',
}

describe('buildManualCallRows', () => {
  it('builds a completed outbound voice_calls row with a call_made activity', () => {
    const { voiceCall, activity } = buildManualCallRows(base)
    expect(voiceCall).toMatchObject({
      organization_id: 'org-1', lead_id: 'lead-1', direction: 'outbound', status: 'completed',
      from_number: 'manual-entry', to_number: 'manual-entry', duration_seconds: 90,
      started_at: '2026-07-01T15:00:00.000Z', ended_at: '2026-07-01T15:00:00.000Z',
      outcome: 'interested', outcome_notes: 'Discussed financing', consent_verified: true,
      metadata: { source: 'manual_log', testimonial_sent: false },
    })
    expect(activity).toMatchObject({
      organization_id: 'org-1', lead_id: 'lead-1', user_id: 'user-1',
      activity_type: 'call_made', description: 'Discussed financing',
    })
  })

  it('records testimonial_sent on the voice_calls metadata', () => {
    const { voiceCall } = buildManualCallRows({ ...base, testimonialSent: true })
    expect(voiceCall.metadata).toMatchObject({ source: 'manual_log', testimonial_sent: true })
  })

  it('uses call_received for inbound direction', () => {
    const { activity } = buildManualCallRows({ ...base, direction: 'inbound' })
    expect(activity.activity_type).toBe('call_received')
  })

  it('tolerates null outcome and notes', () => {
    const { voiceCall, activity } = buildManualCallRows({ ...base, outcome: null, notes: null })
    expect(voiceCall.outcome).toBeNull()
    expect(voiceCall.outcome_notes).toBeNull()
    expect(activity.description).toBeNull()
  })
})

describe('buildLeadCapturePatch', () => {
  it('returns an empty patch when nothing is captured', () => {
    expect(buildLeadCapturePatch({ budgetRange: null, painPoints: null, currentProfile: null })).toEqual({})
  })

  it('sets budget_range for a concrete range', () => {
    expect(
      buildLeadCapturePatch({ budgetRange: '20k_25k', painPoints: null, currentProfile: null })
    ).toEqual({ budget_range: '20k_25k' })
  })

  it("does not set budget_range for 'unknown'", () => {
    expect(
      buildLeadCapturePatch({ budgetRange: 'unknown', painPoints: null, currentProfile: null })
    ).toEqual({})
  })

  it('appends a pain point to an existing array, preserving other profile keys', () => {
    const patch = buildLeadCapturePatch({
      budgetRange: null,
      painPoints: '  Struggles to eat  ',
      currentProfile: { tone: 'anxious', pain_points: ['Loose dentures'] },
    })
    expect(patch.personality_profile).toEqual({
      tone: 'anxious',
      pain_points: ['Loose dentures', 'Struggles to eat'],
    })
  })

  it('coerces a legacy string pain_points value into an array', () => {
    const patch = buildLeadCapturePatch({
      budgetRange: null,
      painPoints: 'New concern',
      currentProfile: { pain_points: 'Old concern' },
    })
    expect(patch.personality_profile).toEqual({ pain_points: ['Old concern', 'New concern'] })
  })

  it('starts a fresh array when there is no profile', () => {
    const patch = buildLeadCapturePatch({
      budgetRange: null,
      painPoints: 'Pain in molar',
      currentProfile: null,
    })
    expect(patch.personality_profile).toEqual({ pain_points: ['Pain in molar'] })
  })

  it('ignores blank pain points', () => {
    expect(
      buildLeadCapturePatch({ budgetRange: null, painPoints: '   ', currentProfile: null })
    ).toEqual({})
  })

  it('combines budget and pain points in one patch', () => {
    const patch = buildLeadCapturePatch({
      budgetRange: 'over_30k',
      painPoints: 'Wants fixed teeth',
      currentProfile: null,
    })
    expect(patch).toEqual({
      budget_range: 'over_30k',
      personality_profile: { pain_points: ['Wants fixed teeth'] },
    })
  })
})
