// Columns whose values must never be snapshotted into audit_events.
// MIRRORED in supabase/migrations/20260704160000_audit_events.sql (audit_row_change). Keep in sync.
export const SENSITIVE_COLUMNS: Record<string, string[]> = {
  leads: ['email', 'phone', 'date_of_birth', 'insurance_id', 'phone_hash', 'email_hash'],
  patient_profiles: ['personal_details'],
  clinical_cases: ['patient_email', 'patient_phone'],
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
