import type { BudgetRange, VoiceCallOutcome } from '@/types/database'

export interface ManualCallInput {
  orgId: string
  leadId: string
  userId: string | null
  direction: 'inbound' | 'outbound'
  outcome: VoiceCallOutcome | null
  durationSeconds: number
  notes: string | null
  testimonialSent: boolean
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
    metadata: { source: 'manual_log', testimonial_sent: input.testimonialSent },
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

export interface LeadCaptureInput {
  budgetRange: BudgetRange | null
  painPoints: string | null
  currentProfile: Record<string, unknown> | null
}

/**
 * Compute the (possibly empty) patch applied to the `leads` row from the
 * structured discovery-call capture fields. `budget_range` is set only when a
 * concrete range is chosen (not null / 'unknown'); pain points are *appended*
 * to `personality_profile.pain_points` so the history across calls is
 * preserved. Returns `{}` when nothing was captured, so callers can skip the
 * write entirely.
 */
export function buildLeadCapturePatch(input: LeadCaptureInput): {
  budget_range?: BudgetRange
  personality_profile?: Record<string, unknown>
} {
  const patch: { budget_range?: BudgetRange; personality_profile?: Record<string, unknown> } = {}

  if (input.budgetRange && input.budgetRange !== 'unknown') {
    patch.budget_range = input.budgetRange
  }

  const painPoint = input.painPoints?.trim()
  if (painPoint) {
    const profile = { ...(input.currentProfile ?? {}) }
    const existing = profile.pain_points
    const priorList = Array.isArray(existing)
      ? existing
      : typeof existing === 'string' && existing.trim()
        ? [existing]
        : []
    profile.pain_points = [...priorList, painPoint]
    patch.personality_profile = profile
  }

  return patch
}
