import { describe, it, expect } from 'vitest'
import { buildHoldTaskInput } from './hold-tasks'

describe('buildHoldTaskInput', () => {
  it('produces a callback task with due_at = hold date and the hold dedupe key', () => {
    const input = buildHoldTaskInput({
      organizationId: 'org1',
      leadId: 'lead1',
      leadName: 'Jane D.',
      holdUntil: '2026-08-03T16:00:00Z',
      reason: 'wants to talk to spouse',
      assignedTo: 'user1',
      assignedRole: 'office_manager',
      createdBy: 'user1',
    })
    expect(input.kind).toBe('callback')
    expect(input.due_at).toBe('2026-08-03T16:00:00Z')
    expect(input.dedupe_key).toBe('hold:lead1')
    expect(input.detail).toContain('spouse')
    expect(input.title).toContain('Jane D.')
    expect(input.source).toBe('lead_hold')
  })
})
