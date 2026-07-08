import { MessagesSquare } from 'lucide-react'

/**
 * Center-pane placeholder for the messenger. The inbox rail lives in the
 * layout, so this is what shows before a thread is picked. Selecting a
 * conversation swaps in `/conversations/[id]` without touching the rail.
 */
export default function ConversationsPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full border border-aurea-border bg-aurea-canvas">
        <MessagesSquare className="h-6 w-6 text-aurea-ink-3" strokeWidth={1.5} />
      </div>
      <p className="aurea-eyebrow mt-5">Messaging</p>
      <h2 className="aurea-display mt-1 text-[24px] text-aurea-ink">Select a conversation</h2>
      <p className="mt-2 max-w-[320px] text-[13.5px] leading-relaxed text-aurea-ink-3">
        Pick a thread from the inbox to read its history, review AI insights, and
        reply over SMS or email.
      </p>
    </div>
  )
}
