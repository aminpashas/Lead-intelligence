import { describe, it, expect } from 'vitest'
import { buildAuditRow } from '@/lib/audit/record'

describe('buildAuditRow', () => {
  it('maps an AuditEventInput to the audit_events insert shape', () => {
    const row = buildAuditRow({
      organizationId: 'org-1', action: 'sms.sent',
      actor: { actorType: 'ai_agent', actorId: 'agent-1', actorLabel: 'AI Setter' },
      source: 'api_route', resourceType: 'lead', resourceId: 'lead-9',
      ai: { autonomous: true, agent_role: 'setter', model: 'claude-sonnet-5' },
    })
    expect(row).toMatchObject({
      organization_id: 'org-1', action: 'sms.sent', actor_type: 'ai_agent',
      actor_id: 'agent-1', actor_label: 'AI Setter', source: 'api_route',
      resource_type: 'lead', resource_id: 'lead-9', severity: 'info',
    })
    expect(row.ai).toMatchObject({ autonomous: true, agent_role: 'setter' })
    expect(row.metadata).toEqual({})
  })
  it('defaults severity to info and metadata to {}', () => {
    const row = buildAuditRow({ organizationId: 'o', action: 'a', actor: { actorType: 'system' }, source: 'cron' })
    expect(row.severity).toBe('info')
    expect(row.metadata).toEqual({})
  })
})
