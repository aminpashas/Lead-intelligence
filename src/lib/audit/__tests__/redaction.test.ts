import { describe, it, expect } from 'vitest'
import { redactRow, SENSITIVE_COLUMNS } from '@/lib/audit/redaction'

describe('redactRow', () => {
  it('replaces denylisted columns for the table with a sentinel', () => {
    const out = redactRow('leads', { id: '1', stage: 'won', email: 'a@b.com', phone: '+15551234567' })
    expect(out.stage).toBe('won')
    expect(out.email).toBe('[redacted]')
    expect(out.phone).toBe('[redacted]')
  })
  it('leaves rows for non-configured tables untouched', () => {
    const row = { id: '1', foo: 'bar' }
    expect(redactRow('connector_configs', row)).toEqual(row)
  })
  it('only redacts keys that are present', () => {
    expect(redactRow('leads', { id: '1', stage: 'won' })).toEqual({ id: '1', stage: 'won' })
  })
  it('denylist includes leads PII columns', () => {
    expect(SENSITIVE_COLUMNS.leads).toEqual(expect.arrayContaining(['email', 'phone', 'date_of_birth', 'insurance_provider']))
  })
})
