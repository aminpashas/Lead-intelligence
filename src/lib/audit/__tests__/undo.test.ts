import { describe, it, expect } from 'vitest'
import { computeUndoPlan, isUndoable, undoableFields, valuesEqual } from '@/lib/audit/undo'
import { isDerivedOnly, meaningfulFields } from '@/lib/audit/fields'

const base = {
  action: 'leads.update',
  resourceType: 'leads',
}

describe('computeUndoPlan', () => {
  it('reverts a stage move — the canonical case', () => {
    const result = computeUndoPlan({
      ...base,
      before: { stage_id: 'new-lead', updated_at: '2026-07-19T22:00:00Z' },
      after: { stage_id: 'consultation-scheduled', updated_at: '2026-07-19T23:00:00Z' },
      changedFields: ['stage_id', 'updated_at'],
      current: { stage_id: 'consultation-scheduled', updated_at: '2026-07-19T23:00:00Z' },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.patch).toEqual({ stage_id: 'new-lead' })
    expect(result.plan.reverted).toEqual(['stage_id'])
    expect(result.plan.skipped).toEqual([{ field: 'updated_at', why: 'derived' }])
  })

  it('NEVER writes the redaction sentinel back over real PII', () => {
    const result = computeUndoPlan({
      ...base,
      before: { phone: '[redacted]', stage_id: 'new-lead' },
      after: { phone: '[redacted]', stage_id: 'contacted' },
      changedFields: ['phone', 'stage_id'],
      current: { phone: '+14155551234', stage_id: 'contacted' },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.patch).not.toHaveProperty('phone')
    expect(result.plan.patch).toEqual({ stage_id: 'new-lead' })
    expect(result.plan.skipped).toContainEqual({ field: 'phone', why: 'redacted' })
  })

  it('skips a field when only `after` is the sentinel', () => {
    // `before` looks like a real value but the column is sensitive, so the
    // snapshot cannot be trusted as a restore source.
    const result = computeUndoPlan({
      ...base,
      before: { email: 'old@example.com', tags: ['a'] },
      after: { email: '[redacted]', tags: ['b'] },
      changedFields: ['email', 'tags'],
      current: { email: 'x@example.com', tags: ['b'] },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.patch).toEqual({ tags: ['a'] })
    expect(result.plan.skipped).toContainEqual({ field: 'email', why: 'redacted' })
  })

  it('refuses when the row moved again after the event', () => {
    const result = computeUndoPlan({
      ...base,
      before: { stage_id: 'new-lead' },
      after: { stage_id: 'contacted' },
      changedFields: ['stage_id'],
      current: { stage_id: 'closed-won' }, // someone else moved it since
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('stale')
    expect(result.refusal).toMatchObject({ fields: ['stage_id'] })
  })

  it('refuses an event that only touched derived fields', () => {
    const result = computeUndoPlan({
      ...base,
      before: { total_sms_sent: 2, updated_at: '2026-07-19T22:00:00Z' },
      after: { total_sms_sent: 3, updated_at: '2026-07-19T23:00:00Z' },
      changedFields: ['total_sms_sent', 'updated_at'],
      current: { total_sms_sent: 3, updated_at: '2026-07-19T23:00:00Z' },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('no_undoable_fields')
    expect(result.refusal.message).toMatch(/system-maintained/)
  })

  it('explains a redaction-only refusal differently from a derived-only one', () => {
    const result = computeUndoPlan({
      ...base,
      before: { phone: '[redacted]' },
      after: { phone: '[redacted]' },
      changedFields: ['phone'],
      current: { phone: '+14155551234' },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.message).toMatch(/protected fields/)
  })

  it('refuses inserts and deletes', () => {
    const insert = computeUndoPlan({
      action: 'leads.insert',
      resourceType: 'leads',
      before: null,
      after: { stage_id: 'new-lead' },
      changedFields: null,
      current: { stage_id: 'new-lead' },
    })
    expect(insert.ok).toBe(false)
    if (insert.ok) return
    expect(insert.refusal.reason).toBe('not_an_update')
  })

  it('refuses tables outside the allowlist', () => {
    const result = computeUndoPlan({
      action: 'invoices.update',
      resourceType: 'invoices',
      before: { status: 'draft' },
      after: { status: 'sent' },
      changedFields: ['status'],
      current: { status: 'sent' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('unsupported_resource')
  })

  it('reverts a field back to null', () => {
    const result = computeUndoPlan({
      ...base,
      before: { disqualified_reason: null },
      after: { disqualified_reason: 'bad fit' },
      changedFields: ['disqualified_reason'],
      current: { disqualified_reason: 'bad fit' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.patch).toEqual({ disqualified_reason: null })
  })
})

describe('valuesEqual', () => {
  it('treats differing timestamp renderings as equal', () => {
    // Postgres jsonb vs PostgREST rendering of the same instant.
    expect(valuesEqual('2026-07-19T23:08:08.867358+00:00', '2026-07-19 23:08:08.867358+00')).toBe(true)
  })

  it('compares arrays and objects structurally', () => {
    expect(valuesEqual(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(valuesEqual(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(valuesEqual({ x: 1 }, { x: 1 })).toBe(true)
  })

  it('does not mistake non-date strings for timestamps', () => {
    expect(valuesEqual('new-lead', 'contacted')).toBe(false)
    expect(valuesEqual('1', '1970-01-01')).toBe(false)
  })

  it('treats null and undefined as the same absent value', () => {
    expect(valuesEqual(null, undefined)).toBe(true)
    expect(valuesEqual(null, '')).toBe(false)
  })
})

describe('isUndoable', () => {
  const row = {
    action: 'leads.update',
    resourceType: 'leads',
    resourceId: 'lead-1',
    changedFields: ['stage_id', 'updated_at'],
  }

  it('accepts a real edit on an allowlisted table', () => {
    expect(isUndoable(row)).toBe(true)
  })

  it('rejects derived-only churn', () => {
    expect(isUndoable({ ...row, changedFields: ['updated_at', 'total_sms_sent'] })).toBe(false)
  })

  it('rejects non-update actions and unsupported tables', () => {
    expect(isUndoable({ ...row, action: 'sms.sent' })).toBe(false)
    expect(isUndoable({ ...row, resourceType: 'invoices' })).toBe(false)
    expect(isUndoable({ ...row, resourceId: null })).toBe(false)
  })
})

describe('field classification', () => {
  it('flags derived-only change sets as churn', () => {
    // The single most common shape in production (120k rows): the counter
    // bump that follows sending an SMS.
    expect(isDerivedOnly(['updated_at', 'total_sms_sent', 'last_contacted_at', 'total_messages_sent'])).toBe(true)
    expect(isDerivedOnly(['stage_id', 'updated_at'])).toBe(false)
  })

  it('does not treat events without changed_fields as churn', () => {
    // Inserts, deletes and api_route events (sms.sent) carry meaning in the
    // action itself, not in a field diff.
    expect(isDerivedOnly(null)).toBe(false)
    expect(isDerivedOnly([])).toBe(false)
  })

  it('agrees with undoableFields on what counts as meaningful', () => {
    const fields = ['stage_id', 'updated_at', 'tags']
    expect(meaningfulFields(fields)).toEqual(['stage_id', 'tags'])
    expect(undoableFields(fields)).toEqual(['stage_id', 'tags'])
  })
})
