'use client'

import { useEffect, useRef } from 'react'
import { Phone, PhoneOff, Bot, User } from 'lucide-react'
import type { LiveCall } from '@/lib/hooks/use-live-call'

const AGENT_LABEL: Record<string, string> = { setter: 'Setter', closer: 'Closer' }

/**
 * Small pill for the thread header showing that a call is happening right now.
 * Green + pulsing while live/connecting, muted once the call ends.
 */
export function LiveCallIndicator({ live }: { live: LiveCall }) {
  if (live.status === 'idle') return null

  const ended = live.status === 'ended'
  const connecting = live.status === 'connecting'
  const label = ended ? 'Call ended' : connecting ? 'Connecting…' : 'On call'

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
        ended
          ? 'border-aurea-border bg-aurea-surface text-aurea-ink-3'
          : 'border-aurea-primary/30 bg-aurea-primary/10 text-aurea-primary'
      }`}
      aria-live="polite"
    >
      {ended ? (
        <PhoneOff className="h-3 w-3" strokeWidth={2} />
      ) : (
        <span className="relative flex h-2 w-2">
          {!connecting && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-aurea-primary opacity-60" />
          )}
          <span className="relative inline-flex h-2 w-2 rounded-full bg-aurea-primary" />
        </span>
      )}
      {label}
    </span>
  )
}

/**
 * In-thread live transcript card. Renders the running Retell transcript as it
 * is spoken, with the AI agent on the right (like our outbound bubbles) and the
 * caller on the left. Auto-scrolls as new lines arrive.
 */
export function LiveCallPanel({ live }: { live: LiveCall }) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [live.entries.length, live.status])

  if (live.status === 'idle') return null

  const ended = live.status === 'ended'
  const agentName = AGENT_LABEL[live.call?.agent_type || ''] || 'AI'
  const dir = live.call?.direction === 'outbound' ? 'Outbound call' : 'Inbound call'

  return (
    <div className="my-3 overflow-hidden rounded-2xl border border-aurea-primary/25 bg-aurea-primary/[0.04]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-aurea-primary/15 px-3.5 py-2">
        <div className="flex items-center gap-2 text-[12px] font-medium text-aurea-ink-2">
          <Phone
            className={`h-3.5 w-3.5 ${ended ? 'text-aurea-ink-3' : 'text-aurea-primary'}`}
            strokeWidth={1.75}
          />
          <span>{dir}</span>
          <span className="text-aurea-border-strong">·</span>
          <span>{agentName}</span>
        </div>
        <LiveCallIndicator live={live} />
      </div>

      {/* Transcript */}
      <div className="flex flex-col gap-2 px-3.5 py-3">
        {live.entries.length === 0 ? (
          <p className="px-1 text-[12px] italic text-aurea-ink-3">
            {ended
              ? 'Call ended. Finalizing transcript…'
              : live.status === 'connecting'
                ? 'Connecting the call…'
                : 'Listening…'}
          </p>
        ) : (
          live.entries.map((e, i) => {
            const isAgent = e.role === 'agent'
            return (
              <div key={i} className={`flex flex-col ${isAgent ? 'items-end' : 'items-start'}`}>
                <div className="mb-0.5 flex items-center gap-1 px-1 text-[10px] text-aurea-ink-3">
                  {isAgent ? (
                    <Bot className="h-2.5 w-2.5 text-aurea-primary" strokeWidth={1.75} />
                  ) : (
                    <User className="h-2.5 w-2.5" strokeWidth={1.75} />
                  )}
                  <span>{isAgent ? agentName : 'Caller'}</span>
                </div>
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-[13px] leading-[1.5] ${
                    isAgent
                      ? 'bg-aurea-ink text-aurea-canvas'
                      : 'border border-aurea-border bg-aurea-surface text-aurea-ink'
                  }`}
                >
                  <p className="whitespace-pre-wrap">{e.content}</p>
                </div>
              </div>
            )
          })
        )}

        {!ended && live.entries.length > 0 && <TypingDots />}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

/** Three bouncing dots — the call is still in progress / more is coming. */
function TypingDots() {
  return (
    <div className="flex items-center gap-1 px-1 pt-0.5" aria-label="Call in progress">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-aurea-primary/60 [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-aurea-primary/60 [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-aurea-primary/60" />
    </div>
  )
}
