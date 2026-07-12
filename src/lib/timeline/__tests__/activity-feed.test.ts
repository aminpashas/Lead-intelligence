import { describe, it, expect } from 'vitest'
import { buildActivityFeed, type ActivitySource } from '../activity-feed'
import type { TimelineInput } from '../types'

function src(over: Partial<ActivitySource> = {}): ActivitySource {
  return { leadId: 'l1', leadName: 'Ada Lovelace', conversationId: 'c1', href: '/conversations/c1', ...over }
}

const emptyInput: TimelineInput = { messages: [], calls: [], activities: [] }

function msg(id: string, at: string): TimelineInput['messages'][number] {
  return {
    id,
    created_at: at,
    channel: 'sms',
    direction: 'inbound',
    body: 'hi',
    subject: null,
    status: 'delivered',
    ai_generated: false,
    sender_type: 'lead',
    sender_name: null,
  }
}

describe('buildActivityFeed', () => {
  it('attaches the matching source to each entry by row id', () => {
    const input: TimelineInput = { ...emptyInput, messages: [msg('m1', '2026-07-10T10:00:00Z')] }
    const sources = new Map<string, ActivitySource>([['m1', src()]])

    const feed = buildActivityFeed(input, sources)

    expect(feed).toHaveLength(1)
    expect(feed[0].id).toBe('m1')
    expect(feed[0].source.href).toBe('/conversations/c1')
    expect(feed[0].source.leadName).toBe('Ada Lovelace')
  })

  it('orders newest-first (opposite of the per-conversation timeline)', () => {
    const input: TimelineInput = {
      ...emptyInput,
      messages: [msg('older', '2026-07-10T09:00:00Z'), msg('newer', '2026-07-10T12:00:00Z')],
    }
    const sources = new Map<string, ActivitySource>([
      ['older', src({ leadId: 'a' })],
      ['newer', src({ leadId: 'b' })],
    ])

    const feed = buildActivityFeed(input, sources)

    expect(feed.map((e) => e.id)).toEqual(['newer', 'older'])
  })

  it('drops entries whose id has no source rather than emitting an unlinkable node', () => {
    const input: TimelineInput = {
      ...emptyInput,
      messages: [msg('m1', '2026-07-10T10:00:00Z'), msg('orphan', '2026-07-10T11:00:00Z')],
    }
    const sources = new Map<string, ActivitySource>([['m1', src()]])

    const feed = buildActivityFeed(input, sources)

    expect(feed.map((e) => e.id)).toEqual(['m1'])
  })
})
