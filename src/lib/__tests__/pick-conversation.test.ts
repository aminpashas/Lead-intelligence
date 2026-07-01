import { describe, it, expect } from 'vitest'
import { pickConversationToAnalyze } from '@/lib/timeline/pick-conversation'

describe('pickConversationToAnalyze', () => {
  it('returns null when there are no conversations', () => {
    expect(pickConversationToAnalyze([])).toBeNull()
  })

  it('returns null when no conversation has at least 2 messages', () => {
    expect(pickConversationToAnalyze([
      { id: 'c1', message_count: 1, last_message_at: '2026-06-01T10:00:00Z', status: 'active' },
    ])).toBeNull()
  })

  it('prefers an active conversation over a closed one with a newer message', () => {
    expect(pickConversationToAnalyze([
      { id: 'closed', message_count: 5, last_message_at: '2026-06-02T10:00:00Z', status: 'closed' },
      { id: 'active', message_count: 3, last_message_at: '2026-06-01T10:00:00Z', status: 'active' },
    ])).toBe('active')
  })

  it('picks the most recently active conversation among eligible ones', () => {
    expect(pickConversationToAnalyze([
      { id: 'old', message_count: 4, last_message_at: '2026-06-01T10:00:00Z', status: 'active' },
      { id: 'new', message_count: 2, last_message_at: '2026-06-03T10:00:00Z', status: 'active' },
    ])).toBe('new')
  })
})
