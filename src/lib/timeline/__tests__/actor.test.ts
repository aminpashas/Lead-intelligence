import { describe, it, expect } from 'vitest'
import { entryActor } from '../actor'
import type { TimelineEntry } from '../types'

function msg(over: Partial<Extract<TimelineEntry, { kind: 'message' }>>): TimelineEntry {
  return {
    kind: 'message', id: 'm', at: '2026-07-10T10:00:00Z', channel: 'sms', direction: 'outbound',
    body: 'hi', subject: null, status: 'sent', aiGenerated: false, senderType: 'user', senderName: 'Dr. Chen',
    ...over,
  }
}

function call(over: Partial<Extract<TimelineEntry, { kind: 'call' }>>): TimelineEntry {
  return {
    kind: 'call', id: 'c', at: '2026-07-10T10:00:00Z', direction: 'outbound', outcome: null,
    durationSeconds: 30, notes: null, transcriptSummary: null, recordingUrl: null, status: 'completed',
    callMode: null, agentType: null, staffUserId: null, ...over,
  }
}

describe('entryActor', () => {
  it('names the staff member behind an outbound text', () => {
    expect(entryActor(msg({ senderType: 'user', senderName: 'Dr. Chen' }))).toEqual({ name: 'Dr. Chen', kind: 'staff' })
  })

  it('labels an AI-generated message as the AI agent', () => {
    expect(entryActor(msg({ senderType: 'ai', senderName: 'Adrian (AI)' }))).toEqual({ name: 'Adrian (AI)', kind: 'ai' })
  })

  it('has no actor for an inbound (lead) message', () => {
    expect(entryActor(msg({ direction: 'inbound', senderType: 'lead', senderName: null }))).toBeNull()
  })

  it('resolves a human call to its staff name via the lookup map', () => {
    const map = new Map([['u1', 'Maria Ops']])
    expect(entryActor(call({ callMode: 'browser', staffUserId: 'u1' }), map)).toEqual({ name: 'Maria Ops', kind: 'staff' })
  })

  it('falls back to a generic label when the staff name is unknown', () => {
    expect(entryActor(call({ callMode: 'bridge', staffUserId: 'u9' }))).toEqual({ name: 'Team member', kind: 'staff' })
  })

  it('labels an AI dialer call by its agent persona', () => {
    expect(entryActor(call({ callMode: 'ai', agentType: 'setter' }))).toEqual({ name: 'AI Setter', kind: 'ai' })
  })

  it('has no actor for a plain inbound call with no operator', () => {
    expect(entryActor(call({ direction: 'inbound', callMode: null, agentType: null, staffUserId: null }))).toBeNull()
  })
})
