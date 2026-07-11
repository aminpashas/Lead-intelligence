'use client'

/**
 * Conversation presence heartbeat (Workstream D4).
 *
 * While the conversation thread is mounted AND the tab is visible, POST a
 * heartbeat to /api/conversations/[id]/presence every 30s. The server upserts
 * the caller's row in `conversation_viewers`; staff notifications (D5) use it
 * to suppress pings to people already looking at the thread.
 *
 * Pauses when document.hidden (no beat → presence naturally expires after the
 * 75s freshness window) and resumes with an immediate beat on re-focus.
 */

import { useEffect } from 'react'

const HEARTBEAT_MS = 30_000

export function useConversationPresence(conversationId: string | null | undefined) {
  useEffect(() => {
    if (!conversationId) return

    const beat = () => {
      if (document.hidden) return
      fetch(`/api/conversations/${conversationId}/presence`, { method: 'POST' }).catch(() => {
        // Presence is best-effort — never surface heartbeat failures.
      })
    }

    beat()
    const interval = setInterval(beat, HEARTBEAT_MS)
    const onVisibility = () => {
      if (!document.hidden) beat()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [conversationId])
}
