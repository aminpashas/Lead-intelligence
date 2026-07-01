import { describe, it, expect } from 'vitest'
import { buildManualCallRows, type ManualCallInput } from '@/lib/timeline/manual-call'

const base: ManualCallInput = {
  orgId: 'org-1', leadId: 'lead-1', userId: 'user-1',
  direction: 'outbound', outcome: 'interested', durationSeconds: 90,
  notes: 'Discussed financing', nowIso: '2026-07-01T15:00:00.000Z',
}

describe('buildManualCallRows', () => {
  it('builds a completed outbound voice_calls row with a call_made activity', () => {
    const { voiceCall, activity } = buildManualCallRows(base)
    expect(voiceCall).toMatchObject({
      organization_id: 'org-1', lead_id: 'lead-1', direction: 'outbound', status: 'completed',
      from_number: 'manual-entry', to_number: 'manual-entry', duration_seconds: 90,
      started_at: '2026-07-01T15:00:00.000Z', ended_at: '2026-07-01T15:00:00.000Z',
      outcome: 'interested', outcome_notes: 'Discussed financing', consent_verified: true,
    })
    expect(activity).toMatchObject({
      organization_id: 'org-1', lead_id: 'lead-1', user_id: 'user-1',
      activity_type: 'call_made', description: 'Discussed financing',
    })
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
