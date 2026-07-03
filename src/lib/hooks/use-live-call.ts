'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Live-call state for a single lead's conversation thread.
 *
 * Polls /api/voice/calls/active on an adaptive interval: slow while nothing is
 * happening, fast while a call is live so the transcript feels real-time. One
 * poll answers both "is a call happening?" and "what has been said so far?".
 */

export type LiveCallStatus = 'idle' | 'connecting' | 'live' | 'ended'

export type LiveTranscriptEntry = { role: 'agent' | 'lead'; content: string }

export type LiveCall = {
  status: LiveCallStatus
  call: {
    id: string
    direction: string
    agent_type: string | null
    started_at: string | null
  } | null
  entries: LiveTranscriptEntry[]
}

const IDLE_MS = 6000 // no call in progress — light background check
const LIVE_MS = 2500 // call in progress — keep the transcript fresh

const EMPTY: LiveCall = { status: 'idle', call: null, entries: [] }

export function useLiveCall(leadId: string | undefined): LiveCall {
  const [state, setState] = useState<LiveCall>(EMPTY)
  // Keep the latest status in a ref so the poll loop can pick its next delay
  // without being re-created on every state change.
  const statusRef = useRef<LiveCallStatus>('idle')

  useEffect(() => {
    if (!leadId) {
      setState(EMPTY)
      return
    }

    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      try {
        const res = await fetch(`/api/voice/calls/active?lead_id=${leadId}`, { cache: 'no-store' })
        if (res.ok && !stopped) {
          const data = await res.json()
          if (!data.active) {
            statusRef.current = 'idle'
            setState((prev) => (prev.status === 'idle' ? prev : EMPTY))
          } else {
            const next: LiveCall = {
              status: (data.status as LiveCallStatus) || 'live',
              call: data.call || null,
              entries: Array.isArray(data.entries) ? data.entries : [],
            }
            statusRef.current = next.status
            setState(next)
          }
        }
      } catch {
        // Network hiccup — keep the last known state and retry on schedule.
      }
      if (!stopped) {
        const active = statusRef.current !== 'idle'
        timer = setTimeout(tick, active ? LIVE_MS : IDLE_MS)
      }
    }

    tick()

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [leadId])

  return state
}
