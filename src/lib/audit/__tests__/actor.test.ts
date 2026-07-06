import { describe, it, expect } from 'vitest'
import { buildActorGucArgs } from '@/lib/audit/actor'

describe('buildActorGucArgs', () => {
  it('maps actor fields to app.* GUC key/value pairs', () => {
    const args = buildActorGucArgs({ actorType: 'ai_agent', actorId: 'agent-1', actorLabel: 'AI Closer', requestId: 'req-9' })
    expect(args).toContainEqual({ key: 'app.actor_type', value: 'ai_agent' })
    expect(args).toContainEqual({ key: 'app.actor_id', value: 'agent-1' })
    expect(args).toContainEqual({ key: 'app.actor_label', value: 'AI Closer' })
    expect(args).toContainEqual({ key: 'app.request_id', value: 'req-9' })
  })
  it('omits GUCs for missing fields (no empty-string identity)', () => {
    expect(buildActorGucArgs({ actorType: 'system' })).toEqual([{ key: 'app.actor_type', value: 'system' }])
  })
})
