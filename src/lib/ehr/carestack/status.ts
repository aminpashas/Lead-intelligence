/**
 * CareStack's status vocabulary → ours.
 *
 * This is the only place CareStack's enums are allowed to be known. The revenue
 * and consult rollups used to hardcode `status_id === 3` and the literal string
 * 'checked out', which quietly made lead-outcome attribution CareStack-only.
 * Keeping the mapping here means a second EMR maps its own codes onto the same
 * vocabulary and the rollup is unchanged.
 */
import type { NormalizedProcedureStatus, NormalizedApptOutcome } from '../port'

/** CareStack treatment-procedure status enum (verified live). */
export const PROC_STATUS_ACCEPTED = 3
export const PROC_STATUS_COMPLETED = 8

/**
 * Only Accepted and Completed carry money in the rollup — everything else is
 * 'other' so it contributes neither treatment_value nor a conversion date. This
 * preserves the previous behaviour exactly (the old code `continue`d on anything
 * that wasn't 3 or 8).
 */
export function normalizeProcedureStatus(statusId: unknown): NormalizedProcedureStatus {
  const n = typeof statusId === 'number' ? statusId : Number(statusId)
  if (n === PROC_STATUS_ACCEPTED) return 'accepted'
  if (n === PROC_STATUS_COMPLETED) return 'completed'
  return 'other'
}

/**
 * CareStack appointment statuses seen live: Scheduled, Confirmed, Checked Out,
 * Missed, Cancelled, Blocked. 'Blocked' is an operatory hold with no patient and
 * never reaches the rollup, but it is mapped defensively anyway.
 *
 * Note 'rescheduled' and 'cancelled' both map to 'ignored': the old consult
 * rollup skipped both outright, and a rescheduled visit is counted at its new row.
 */
export function normalizeAppointmentStatus(status: unknown): NormalizedApptOutcome {
  const s = String(status ?? '').trim().toLowerCase()
  if (s === 'cancelled' || s === 'canceled' || s === 'rescheduled' || s === 'blocked') return 'ignored'
  if (s === 'missed' || s === 'no show' || s === 'no_show' || s === 'noshow') return 'no_show'
  if (s === 'checked out' || s === 'checkedout') return 'completed'
  return 'scheduled'
}
