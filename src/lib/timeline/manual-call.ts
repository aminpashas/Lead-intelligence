import type { VoiceCallOutcome } from '@/types/database'

export interface ManualCallInput {
  orgId: string
  leadId: string
  userId: string | null
  direction: 'inbound' | 'outbound'
  outcome: VoiceCallOutcome | null
  durationSeconds: number
  notes: string | null
  nowIso: string
}

export interface ManualCallRows {
  voiceCall: Record<string, unknown>
  activity: Record<string, unknown>
}

/**
 * Map a manual call-log request into the two rows we persist: a completed
 * `voice_calls` row and a `lead_activities` audit row. Numbers are stored as a
 * 'manual-entry' placeholder (the NOT NULL columns are satisfied without
 * implying real telephony — a later phase wires transcription/real numbers).
 */
export function buildManualCallRows(input: ManualCallInput): ManualCallRows {
  const voiceCall = {
    organization_id: input.orgId,
    lead_id: input.leadId,
    direction: input.direction,
    status: 'completed',
    from_number: 'manual-entry',
    to_number: 'manual-entry',
    duration_seconds: input.durationSeconds,
    started_at: input.nowIso,
    ended_at: input.nowIso,
    outcome: input.outcome,
    outcome_notes: input.notes,
    consent_verified: true,
    metadata: { source: 'manual_log' },
  }

  const activity = {
    organization_id: input.orgId,
    lead_id: input.leadId,
    user_id: input.userId,
    activity_type: input.direction === 'outbound' ? 'call_made' : 'call_received',
    title: input.direction === 'outbound' ? 'Call logged (outbound)' : 'Call logged (inbound)',
    description: input.notes,
  }

  return { voiceCall, activity }
}
