/**
 * Field classification shared by the audit timeline's noise filter and the
 * undo engine. One list serves both because the question is the same:
 * "did a person meaningfully change this, or did the system bookkeep?"
 *
 * DERIVED_FIELDS are columns the system maintains as a side effect of some
 * other action — counters bumped by sending a message, sync ids written by
 * the GHL puller, enrichment stamps. They are never worth showing on their
 * own, and reverting them would corrupt the very bookkeeping they exist for
 * (e.g. rewinding total_sms_sent does not un-send the SMS).
 *
 * Measured against production 2026-07-19: events whose changed_fields are
 * ENTIRELY within this set are 50.5% of all audit rows.
 */
export const DERIVED_FIELDS: ReadonlySet<string> = new Set([
  'updated_at',
  'created_at',
  'enriched_at',
  'enrichment_status',
  'last_synced_at',
  'last_contacted_at',
  'last_responded_at',
  'total_sms_sent',
  'total_sms_received',
  'total_messages_sent',
  'total_messages_received',
  'total_calls',
  'total_emails_sent',
  'ghl_contact_id',
  'ai_score_updated_at',
])

/**
 * The literal the DB trigger substitutes for any sensitive column before
 * storing a before/after snapshot (audit_row_change, migration
 * 20260704170000 — redaction is by column-NAME PATTERN, so the set of
 * redacted columns is wider than any list we could hardcode here).
 *
 * Matching on the sentinel VALUE rather than a column list is deliberate:
 * it stays correct as the pattern widens.
 */
export const REDACTED = '[redacted]'

/** True when a value was redacted out of the audit snapshot. */
export function isRedacted(value: unknown): boolean {
  return value === REDACTED
}

/** The subset of `changedFields` that represents a real, human-visible edit. */
export function meaningfulFields(changedFields: readonly string[]): string[] {
  return changedFields.filter((f) => !DERIVED_FIELDS.has(f))
}

/**
 * True when an event's only changes were system bookkeeping. Events with no
 * recorded changed_fields (inserts, deletes, api_route events like sms.sent)
 * are NOT churn — they carry meaning in the action itself.
 */
export function isDerivedOnly(changedFields: readonly string[] | null): boolean {
  if (!changedFields || changedFields.length === 0) return false
  return meaningfulFields(changedFields).length === 0
}
