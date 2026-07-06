import { describe, it, expect } from 'vitest'
import { normalizeTimeline } from '@/lib/audit/query'

describe('normalizeTimeline', () => {
  it('merges audit_events and hipaa rows, newest first', () => {
    const audit = [{
      id: 'a1', occurred_at: '2026-07-04T10:00:00Z', actor_type: 'ai_agent',
      actor_label: 'AI Closer', action: 'sms.sent', resource_type: 'lead',
      resource_id: 'l1', changed_fields: null, ai: { autonomous: true }, severity: 'info',
    }]
    const hipaa = [{
      id: 'h1', created_at: '2026-07-04T11:00:00Z', actor_type: 'user',
      actor_id: 'u1', event_type: 'phi_access', resource_type: 'lead',
      resource_id: 'l1', severity: 'info', description: 'viewed',
    }]
    const rows = normalizeTimeline(audit as any, hipaa as any)
    expect(rows.map(r => r.id)).toEqual(['h1', 'a1'])
    expect(rows[0].origin).toBe('hipaa_audit_log')
    expect(rows[1].origin).toBe('audit_events')
    expect(rows[1].changedFields).toEqual([])
  })
})
