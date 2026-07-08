// Per-table denylist for the app-side redactRow() helper. NOTE: the DB trigger
// (audit_row_change, migration 20260704170000) redacts by column-NAME PATTERN
// across all audited tables — a superset of this list — so newly-audited tables
// are protected automatically. This explicit map is the app-path fallback.
export const SENSITIVE_COLUMNS: Record<string, string[]> = {
  leads: ['first_name', 'last_name', 'email', 'phone', 'phone_formatted', 'date_of_birth', 'insurance_provider', 'phone_hash', 'email_hash'],
  patient_profiles: ['personal_details'],
  clinical_cases: ['patient_name', 'patient_email', 'patient_phone'],
}

export function redactRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const denied = SENSITIVE_COLUMNS[table]
  if (!denied) return row
  const out: Record<string, unknown> = { ...row }
  for (const col of denied) {
    if (col in out) out[col] = '[redacted]'
  }
  return out
}
