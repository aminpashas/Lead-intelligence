'use client'

/**
 * Ask bar — the slim always-visible entry point to the AI Command Center.
 *
 * Renders as a single input. On first submit it swaps itself for the full
 * CommandCenter chat (which auto-sends the typed question), so the dashboard
 * stays quiet until the user actually wants a conversation.
 */

import { useState } from 'react'
import { CommandCenter } from '@/components/crm/command-center'
import { Sparkles, SendHorizonal } from 'lucide-react'

export function AskBar({ userName }: { userName: string }) {
  const [expanded, setExpanded] = useState(false)
  const [firstMessage, setFirstMessage] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')

  if (expanded) {
    return <CommandCenter userName={userName} initialMessage={firstMessage} />
  }

  function open(message?: string) {
    setFirstMessage(message?.trim() || undefined)
    setExpanded(true)
  }

  return (
    <div className="aurea-card flex items-center gap-3 px-4 py-2.5">
      <Sparkles className="h-4 w-4 shrink-0 text-aurea-primary" strokeWidth={1.75} />
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            open(draft)
          }
        }}
        placeholder='Ask anything or give me a task — "who should I call first today?"'
        className="min-w-0 flex-1 bg-transparent text-[14px] text-aurea-ink placeholder:text-aurea-ink-3 focus:outline-none"
      />
      <button
        onClick={() => open(draft)}
        aria-label="Open AI command center"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-aurea-ink-3 transition-colors hover:bg-aurea-surface-2 hover:text-aurea-ink"
      >
        <SendHorizonal className="h-4 w-4" strokeWidth={1.75} />
      </button>
    </div>
  )
}
