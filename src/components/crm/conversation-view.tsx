'use client'

import { useState } from 'react'
import { MessagesSquare, GitBranch } from 'lucide-react'
import { ConversationThread } from './conversation-thread'
import { TimelineFeed } from './lead-timeline'
import type { Conversation, Lead, Message, VoiceCall, ConversationAnalysis, PatientProfile, PipelineStage } from '@/types/database'
import type { TimelineEntry } from '@/lib/timeline/types'
import type { LeadNote } from './lead-notes-panel'

type Mode = 'thread' | 'timeline'

/**
 * Wraps the conversation surface with a Thread ⇄ Timeline switch:
 *   • Thread   — the full message-bubble conversation (default).
 *   • Timeline — a condensed, scannable spine of the same calls/texts/emails,
 *                for skimming a long history at a glance. Reuses the patient
 *                card's elevated TimelineFeed; no thread internals are touched.
 */
export function ConversationView({
  lead,
  stages = [],
  conversation,
  messages,
  calls,
  timeline,
  prequalEnabled = false,
  noShowFeeEnabled = false,
  savedAnalysis = null,
  patientProfile = null,
  timeZone,
  embedded = false,
  canTrainAi = false,
  notes = [],
  currentUserId = null,
}: {
  lead: Lead
  /** Org pipeline stages, forwarded so the thread can move the lead's stage. */
  stages?: PipelineStage[]
  conversation: Conversation
  messages: Message[]
  calls: VoiceCall[]
  timeline: TimelineEntry[]
  /** Admin roles only (computed server-side): shows the per-call "Use for AI
   *  training" control, forwarded to the thread's call cards. */
  canTrainAi?: boolean
  /** Account financing pre-qualification switch, forwarded to the action bar. */
  prequalEnabled?: boolean
  /** Practice no-show fee switch, forwarded to the action bar's "Card link". */
  noShowFeeEnabled?: boolean
  /** Persisted intelligence, forwarded to seed the thread's side panel. */
  savedAnalysis?: ConversationAnalysis | null
  patientProfile?: PatientProfile | null
  /** Practice IANA timezone, forwarded so thread timestamps render zone-fixed. */
  timeZone?: string
  /** Rendered inside the messenger shell — drop the thread's standalone card
   *  chrome + back arrow (the inbox rail already provides navigation). */
  embedded?: boolean
  /** Manual team notes for the lead, forwarded to the thread's Notes panel. */
  notes?: LeadNote[]
  /** Viewer's user id — notes expose edit/delete only on the author's own rows. */
  currentUserId?: string | null
}) {
  const [mode, setMode] = useState<Mode>('thread')

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-end border-b border-aurea-border px-4 py-2">
        <div className="inline-flex items-center rounded-full border border-aurea-border bg-aurea-surface p-0.5 text-[12px]">
          <ModeButton active={mode === 'thread'} onClick={() => setMode('thread')} icon={<MessagesSquare className="h-3.5 w-3.5" strokeWidth={1.75} />} label="Thread" />
          <ModeButton active={mode === 'timeline'} onClick={() => setMode('timeline')} icon={<GitBranch className="h-3.5 w-3.5" strokeWidth={1.75} />} label="Timeline" />
        </div>
      </div>

      {mode === 'thread' ? (
        <div className="min-h-0 flex-1">
          <ConversationThread lead={lead} stages={stages} conversation={conversation} messages={messages} calls={calls} prequalEnabled={prequalEnabled} noShowFeeEnabled={noShowFeeEnabled} savedAnalysis={savedAnalysis} patientProfile={patientProfile} timeZone={timeZone} embedded={embedded} canTrainAi={canTrainAi} notes={notes} currentUserId={currentUserId} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
          {timeline.length === 0 ? (
            <p className="py-16 text-center text-sm text-aurea-ink-3">No calls, texts, or emails yet.</p>
          ) : (
            <div className="mx-auto max-w-[680px]">
              <TimelineFeed entries={timeline} timeZone={timeZone} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ModeButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      // The inactive half used to sit at ink-3 (the faintest ink in the system),
      // which read as decoration — staff never found the Timeline view. ink-2 +
      // a hover surface makes it legible as a real control.
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium transition-colors ${
        active
          ? 'bg-aurea-ink text-aurea-canvas'
          : 'text-aurea-ink-2 hover:bg-aurea-surface-2 hover:text-aurea-ink'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}
