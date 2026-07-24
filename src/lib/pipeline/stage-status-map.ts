/**
 * Map a pipeline board stage (`leads.stage_id` → slug) onto the `leads.status`
 * lifecycle value it implies, and decide when a stage move should ADVANCE status.
 *
 * WHY THIS EXISTS
 * ---------------
 * `leads.status` and `leads.stage_id` are two different fields. Real LI booking
 * surfaces set both, but the GHL import/reconcile path sets only `stage_id` from
 * the GHL stage label — so a booked/contracted lead can sit at
 * "Consultation Scheduled" on the board while `status` is still frozen at 'new'.
 * Every status-based consumer (campaign targeting, scoring eligibility,
 * analytics/funnel counts) then sees a stale value. This module is the shared,
 * MONOTONIC rule that lets the reconcile path bring `status` forward to match the
 * board when it advances a lead into the funnel.
 *
 * SAFETY: forward-only. It never drags status backward, never resurrects a
 * terminal lead (lost/disqualified), and never itself sets a terminal status —
 * so it cannot trigger disqualification/loss side-effects. Off-funnel and
 * operational stages (nurturing, dnd-sms, no-show, existing-patient, junk) map
 * to null (no status implication).
 */

import type { LeadStatus } from '@/types/database'

/** Board stage slug → the funnel `LeadStatus` it implies. Funnel stages only. */
const STAGE_SLUG_TO_STATUS: Record<string, LeadStatus> = {
  new: 'new',
  'no-communication': 'new',
  contacted: 'contacted',
  'following-up': 'contacted',
  engaged: 'contacted',
  qualified: 'qualified',
  'consultation-scheduled': 'consultation_scheduled',
  'consultation-completed': 'consultation_completed',
  'treatment-presented': 'treatment_presented',
  financing: 'financing',
  'contract-signed': 'contract_signed',
  scheduled: 'scheduled',
  completed: 'completed',
}

/** Forward ordering of the active funnel statuses. Higher = further along. */
const STATUS_RANK: Record<string, number> = {
  new: 0,
  contacted: 1,
  qualified: 2,
  consultation_scheduled: 3,
  consultation_completed: 4,
  treatment_presented: 5,
  financing: 6,
  contract_sent: 7,
  contract_signed: 8,
  scheduled: 9,
  in_treatment: 10,
  completed: 11,
}

/** Statuses that must never be advanced forward by a stage move. */
const TERMINAL_STATUSES = new Set<string>(['lost', 'disqualified'])

/** The funnel status a board stage implies, or null for operational/off-funnel stages. */
export function stageSlugToStatus(slug: string | null | undefined): LeadStatus | null {
  if (!slug) return null
  return STAGE_SLUG_TO_STATUS[slug] ?? null
}

/**
 * Pure decision: given a lead's current status and the stage it's moving to,
 * return the status to ADVANCE to, or null when status should stay put.
 *
 * Returns null when: the target stage has no funnel status, the current status
 * is terminal (lost/disqualified), or the move would not go strictly forward
 * (equal or backward rank). An unknown/absent current status ranks below 'new',
 * so a real funnel stage still advances it.
 */
export function advancedStatusForStage(input: {
  currentStatus: string | null | undefined
  targetSlug: string | null | undefined
}): LeadStatus | null {
  const target = stageSlugToStatus(input.targetSlug)
  if (!target) return null

  const current = input.currentStatus ?? null
  if (current && TERMINAL_STATUSES.has(current)) return null

  const currentRank = current && current in STATUS_RANK ? STATUS_RANK[current] : -1
  if (STATUS_RANK[target] <= currentRank) return null

  return target
}
