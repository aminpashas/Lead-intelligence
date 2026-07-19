import { DERIVED_FIELDS, isRedacted } from '@/lib/audit/fields'

/**
 * Undo engine for audit events.
 *
 * Undo is a FORWARD action, never an erasure — audit_events is WORM (see the
 * prevent_row_mutation trigger). Reverting a change writes the old values back
 * onto the live row and records a NEW audit event describing the revert. The
 * original event stays exactly where it was.
 *
 * Three guards, in order of how badly they bite:
 *
 *  1. REDACTED — the DB trigger replaces sensitive columns with the literal
 *     '[redacted]' before storing a snapshot. Writing that back would stamp
 *     the string "[redacted]" over a real patient phone number. This is the
 *     one failure mode that destroys data rather than merely annoying someone.
 *  2. DERIVED — counters and sync stamps. Rewinding total_sms_sent does not
 *     un-send the SMS; it just makes the counter lie.
 *  3. STALE — if the row moved again after this event, the value we'd restore
 *     is no longer the value this event replaced. Refuse rather than silently
 *     clobbering someone else's newer edit.
 */

/**
 * Tables an undo may write to, mapped to the permission required. Deliberately
 * an allowlist: an audit event exists for many tables (invoices, contracts,
 * financing_submissions) where a blind field revert would be unsafe or would
 * bypass that domain's own state machine.
 */
export const UNDOABLE_RESOURCES: Record<string, { permission: string; label: string }> = {
  leads: { permission: 'leads:write', label: 'lead' },
  appointments: { permission: 'schedule:write', label: 'appointment' },
}

export type SkipReason = 'derived' | 'redacted'

export type UndoPlan = {
  /** Column → value to write back. Never empty on a successful plan. */
  patch: Record<string, unknown>
  /** Fields the patch will revert. */
  reverted: string[]
  /** Fields deliberately left alone, and why. */
  skipped: { field: string; why: SkipReason }[]
}

export type UndoRefusal =
  | { reason: 'not_an_update'; message: string }
  | { reason: 'unsupported_resource'; message: string }
  | { reason: 'no_undoable_fields'; message: string }
  | { reason: 'stale'; message: string; fields: string[] }

export type UndoResult =
  | { ok: true; plan: UndoPlan }
  | { ok: false; refusal: UndoRefusal }

/**
 * Compares a live column value against the value the audit snapshot recorded.
 *
 * Timestamps need normalizing: Postgres jsonb renders them as
 * '2026-07-19 23:08:08.867358+00' while PostgREST returns
 * '2026-07-19T23:08:08.867358+00:00'. A naive === would call every timestamped
 * row stale. Objects and arrays (tags, jsonb columns) compare structurally.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null)
  }
  if (typeof a === 'string' && typeof b === 'string') {
    const ta = Date.parse(a)
    const tb = Date.parse(b)
    // Only treat as timestamps when BOTH parse and the strings look
    // date-shaped — otherwise "1" and "1970-01-01" style coincidences bite.
    if (!Number.isNaN(ta) && !Number.isNaN(tb) && /\d{4}-\d{2}-\d{2}/.test(a) && /\d{4}-\d{2}-\d{2}/.test(b)) {
      return ta === tb
    }
    return false
  }
  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}

/** Fields of an event that undo would even consider touching. */
export function undoableFields(changedFields: readonly string[] | null): string[] {
  if (!changedFields) return []
  return changedFields.filter((f) => !DERIVED_FIELDS.has(f))
}

/**
 * Cheap, snapshot-free check used to decide whether to render an Undo button.
 * Intentionally does NOT load before/after — the timeline lists 200 rows and
 * those jsonb blobs are large. The authoritative check is computeUndoPlan,
 * run server-side when the button is actually clicked.
 */
export function isUndoable(row: {
  action: string
  resourceType: string | null
  resourceId: string | null
  changedFields: readonly string[]
}): boolean {
  if (!row.action.endsWith('.update')) return false
  if (!row.resourceType || !row.resourceId) return false
  if (!(row.resourceType in UNDOABLE_RESOURCES)) return false
  return undoableFields(row.changedFields).length > 0
}

export function computeUndoPlan(input: {
  action: string
  resourceType: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  changedFields: readonly string[] | null
  /** The row as it stands right now. */
  current: Record<string, unknown>
}): UndoResult {
  const { action, resourceType, before, after, changedFields, current } = input

  if (!action.endsWith('.update') || !before || !after) {
    return {
      ok: false,
      refusal: {
        reason: 'not_an_update',
        message: 'Only field edits can be undone. Creations and deletions are not reversible here.',
      },
    }
  }

  if (!resourceType || !(resourceType in UNDOABLE_RESOURCES)) {
    return {
      ok: false,
      refusal: {
        reason: 'unsupported_resource',
        message: `Undo is not available for ${resourceType ?? 'this record'}.`,
      },
    }
  }

  const patch: Record<string, unknown> = {}
  const reverted: string[] = []
  const skipped: { field: string; why: SkipReason }[] = []
  const stale: string[] = []

  for (const field of changedFields ?? []) {
    if (DERIVED_FIELDS.has(field)) {
      skipped.push({ field, why: 'derived' })
      continue
    }
    // Guard on the sentinel in EITHER snapshot: if `after` is redacted the
    // column is sensitive, so `before` is untrustworthy even if it happens to
    // hold a non-sentinel value.
    if (isRedacted(before[field]) || isRedacted(after[field])) {
      skipped.push({ field, why: 'redacted' })
      continue
    }
    if (!valuesEqual(current[field], after[field])) {
      stale.push(field)
      continue
    }
    patch[field] = before[field]
    reverted.push(field)
  }

  if (stale.length > 0) {
    return {
      ok: false,
      refusal: {
        reason: 'stale',
        message:
          `This record changed again after this event (${stale.join(', ')}). ` +
          `Undoing now would overwrite the newer change.`,
        fields: stale,
      },
    }
  }

  if (reverted.length === 0) {
    const why = skipped.some((s) => s.why === 'redacted')
      ? 'Its changes were to protected fields, which are not stored in the audit log.'
      : 'It only changed system-maintained fields.'
    return {
      ok: false,
      refusal: { reason: 'no_undoable_fields', message: `Nothing to undo. ${why}` },
    }
  }

  return { ok: true, plan: { patch, reverted, skipped } }
}
