import type { Conversation } from '@/types/database'

/**
 * Choose which conversation to feed the AI analyzer: it needs ≥2 messages
 * (per /api/ai/analyze), and we prefer an active conversation, then the most
 * recent by last_message_at. Returns null when nothing is analyzable.
 */
export function pickConversationToAnalyze(
  conversations: Pick<Conversation, 'id' | 'message_count' | 'last_message_at' | 'status'>[]
): string | null {
  const eligible = conversations.filter((c) => (c.message_count ?? 0) >= 2)
  if (eligible.length === 0) return null

  const sorted = [...eligible].sort((a, b) => {
    const aActive = a.status === 'active' ? 1 : 0
    const bActive = b.status === 'active' ? 1 : 0
    if (aActive !== bActive) return bActive - aActive
    const at = a.last_message_at ?? ''
    const bt = b.last_message_at ?? ''
    return at < bt ? 1 : at > bt ? -1 : 0
  })

  return sorted[0].id
}
