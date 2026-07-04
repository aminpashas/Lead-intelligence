'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { format, formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { Card, CardContent } from '@/components/ui/card'
import { LeadMessaging } from './lead-messaging'
import { LogCallDialog } from './log-call-dialog'
import {
  MessageSquare, Mail, Phone, PhoneIncoming, PhoneOutgoing,
  StickyNote, GitBranch, Sparkles, Play, ChevronRight,
} from 'lucide-react'
import type { Lead } from '@/types/database'
import type { TimelineEntry } from '@/lib/timeline/types'

const CHANNEL_ICON = {
  sms: MessageSquare,
  whatsapp: MessageSquare,
  web_chat: MessageSquare,
  email: Mail,
  voice: Phone,
} as const

function labelFor(entry: TimelineEntry): string {
  if (entry.kind === 'message') return entry.channel === 'email' ? 'Email' : 'SMS'
  if (entry.kind === 'call') return `Call · ${entry.direction}${entry.outcome ? ` · ${entry.outcome.replace(/_/g, ' ')}` : ''}`
  if (entry.kind === 'note') return 'Note'
  return 'Stage change'
}

function IconFor({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === 'message') {
    const Icon = CHANNEL_ICON[entry.channel] ?? MessageSquare
    return <Icon className="h-4 w-4" strokeWidth={1.75} />
  }
  if (entry.kind === 'call') return <Phone className="h-4 w-4" strokeWidth={1.75} />
  if (entry.kind === 'note') return <StickyNote className="h-4 w-4" strokeWidth={1.75} />
  return <GitBranch className="h-4 w-4" strokeWidth={1.75} />
}

type ViewMode = 'summary' | 'detailed'

export function LeadTimeline({ lead, entries }: { lead: Lead; entries: TimelineEntry[] }) {
  const router = useRouter()
  // Default to the elevated view; the compact "Summary" stays one click away.
  const [view, setView] = useState<ViewMode>('detailed')

  // Live-refresh when a new message arrives for this lead.
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`lead-timeline-${lead.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `lead_id=eq.${lead.id}` },
        () => router.refresh()
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [lead.id, router])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <LeadMessaging lead={lead} />
          <LogCallDialog leadId={lead.id} />
        </div>
        {entries.length > 0 && <ViewToggle view={view} onChange={setView} />}
      </div>

      {entries.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-aurea-ink-3">
            No calls, texts, or emails yet. Use the actions above to start the conversation.
          </CardContent>
        </Card>
      ) : view === 'summary' ? (
        <SummaryTimeline entries={entries} />
      ) : (
        <DetailedTimeline entries={entries} />
      )}
    </div>
  )
}

// ── View toggle ─────────────────────────────────────────────
function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="inline-flex shrink-0 items-center rounded-full border border-aurea-border bg-aurea-surface p-0.5 text-[11px]">
      {(['summary', 'detailed'] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={view === v}
          className={`rounded-full px-2.5 py-1 font-medium capitalize transition-colors ${
            view === v ? 'bg-aurea-ink text-aurea-canvas' : 'text-aurea-ink-3 hover:text-aurea-ink'
          }`}
        >
          {v}
        </button>
      ))}
    </div>
  )
}

// ── Summary (compact) — the original list view ──────────────
function SummaryTimeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol className="space-y-3">
      {entries.map((entry) => {
        const outbound = (entry.kind === 'message' || entry.kind === 'call') && entry.direction === 'outbound'
        return (
          <li key={`${entry.kind}-${entry.id}`} className={outbound ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`max-w-[80%] rounded-lg border border-aurea-border px-3 py-2 ${outbound ? 'bg-aurea-surface-2' : 'bg-aurea-surface'}`}>
              <div className="mb-1 flex items-center gap-1.5 text-xs text-aurea-ink-3">
                <IconFor entry={entry} />
                <span>{labelFor(entry)}</span>
                <span>·</span>
                <span>{formatDistanceToNow(new Date(entry.at), { addSuffix: true })}</span>
                {entry.kind === 'message' && entry.aiGenerated && <span className="rounded bg-aurea-border/40 px-1">AI</span>}
              </div>
              {entry.kind === 'message' && (
                <>
                  {entry.subject && <p className="text-sm font-medium text-aurea-ink">{entry.subject}</p>}
                  <p className="whitespace-pre-wrap text-sm text-aurea-ink-2">{entry.body}</p>
                </>
              )}
              {entry.kind === 'call' && (
                <p className="text-sm text-aurea-ink-2">
                  {entry.durationSeconds > 0 && <span>{Math.round(entry.durationSeconds / 60)} min. </span>}
                  {entry.notes ?? entry.transcriptSummary ?? 'No notes.'}
                </p>
              )}
              {(entry.kind === 'note' || entry.kind === 'stage_change') && (
                <p className="whitespace-pre-wrap text-sm text-aurea-ink-2">{entry.body || entry.title}</p>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

// ── Detailed (elevated) — a ruled vertical spine with node markers ──
function fmtDuration(seconds: number): string | null {
  if (!seconds || seconds <= 0) return null
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Accent tone for a node, keyed to the entry's meaning (Aurea palette). */
function nodeTone(entry: TimelineEntry): string {
  if (entry.kind === 'note') return 'border-aurea-gold/50 text-aurea-gold'
  if (entry.kind === 'call') return 'border-aurea-border-strong text-aurea-ink'
  if (entry.kind === 'message' && entry.aiGenerated) return 'border-aurea-primary/50 text-aurea-primary'
  if (entry.kind === 'message' && entry.direction === 'outbound') return 'border-aurea-border-strong text-aurea-ink-2'
  return 'border-aurea-border text-aurea-ink-3'
}

function DetailedTimeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <div className="relative pl-9">
      {/* The spine — one hairline the whole column hangs from. */}
      <div className="absolute bottom-2 left-[14px] top-2 w-px bg-aurea-border" aria-hidden />
      <ol className="space-y-5">
        {entries.map((entry) => (
          <li key={`${entry.kind}-${entry.id}`} className="relative">
            {/* Node marker sitting on the spine */}
            <span
              className={`absolute -left-9 top-0 flex h-7 w-7 items-center justify-center rounded-full border bg-aurea-surface ${nodeTone(entry)}`}
            >
              <NodeIcon entry={entry} />
            </span>

            {/* Header line: type · badges · time */}
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="aurea-eyebrow leading-none">{typeLabel(entry)}</span>
              {entry.kind === 'call' && entry.outcome && (
                <span className="rounded-full border border-aurea-border px-1.5 py-px text-[10px] font-medium capitalize text-aurea-ink-2">
                  {entry.outcome.replace(/_/g, ' ')}
                </span>
              )}
              {entry.kind === 'message' && entry.aiGenerated && (
                <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-aurea-primary">
                  <Sparkles className="h-2.5 w-2.5" strokeWidth={2} /> AI
                </span>
              )}
              <span className="ml-auto font-mono text-[11px] tabular-nums text-aurea-ink-3" title={format(new Date(entry.at), 'PPpp')}>
                {format(new Date(entry.at), 'MMM d · h:mm a')}
              </span>
            </div>

            {/* Body */}
            <div className="mt-1.5">
              {entry.kind === 'message' && <MessageBody entry={entry} />}
              {entry.kind === 'call' && <CallBody entry={entry} />}
              {entry.kind === 'note' && (
                <div className="border-l-2 border-aurea-gold/60 pl-3">
                  <p className="whitespace-pre-wrap text-[13.5px] leading-[1.55] text-aurea-ink-2">{entry.body || entry.title}</p>
                </div>
              )}
              {entry.kind === 'stage_change' && (
                <p className="text-[13px] text-aurea-ink-2">
                  {entry.title}
                  {entry.body && entry.body !== entry.title && <span className="text-aurea-ink-3"> — {entry.body}</span>}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function NodeIcon({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === 'call') {
    return entry.direction === 'outbound'
      ? <PhoneOutgoing className="h-3.5 w-3.5" strokeWidth={1.75} />
      : <PhoneIncoming className="h-3.5 w-3.5" strokeWidth={1.75} />
  }
  if (entry.kind === 'message') {
    const Icon = CHANNEL_ICON[entry.channel] ?? MessageSquare
    return <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
  }
  if (entry.kind === 'note') return <StickyNote className="h-3.5 w-3.5" strokeWidth={1.75} />
  return <GitBranch className="h-3.5 w-3.5" strokeWidth={1.75} />
}

function typeLabel(entry: TimelineEntry): string {
  if (entry.kind === 'message') {
    const ch = entry.channel === 'email' ? 'Email' : entry.channel === 'sms' ? 'SMS' : 'Message'
    return `${entry.direction === 'outbound' ? 'Sent' : 'Received'} · ${ch}`
  }
  if (entry.kind === 'call') return entry.direction === 'outbound' ? 'Outbound call' : 'Inbound call'
  if (entry.kind === 'note') return 'Note'
  return 'Stage change'
}

function MessageBody({ entry }: { entry: Extract<TimelineEntry, { kind: 'message' }> }) {
  const outbound = entry.direction === 'outbound'
  return (
    <div className={`rounded-xl border border-aurea-border px-3.5 py-2.5 ${outbound ? 'bg-aurea-surface-2' : 'bg-aurea-surface'}`}>
      {entry.subject && <p className="aurea-display mb-1 text-[15px] leading-snug text-aurea-ink">{entry.subject}</p>}
      <p className="whitespace-pre-wrap text-[13.5px] leading-[1.55] text-aurea-ink-2">{entry.body}</p>
      {entry.status === 'failed' && (
        <span className="mt-1.5 inline-block rounded border border-aurea-rose/30 bg-aurea-rose/10 px-1.5 py-0.5 text-[10px] font-medium text-aurea-rose">
          Failed to deliver
        </span>
      )}
    </div>
  )
}

function CallBody({ entry }: { entry: Extract<TimelineEntry, { kind: 'call' }> }) {
  const duration = fmtDuration(entry.durationSeconds)
  const summary = entry.notes ?? entry.transcriptSummary
  return (
    <div className="rounded-xl border border-aurea-border bg-aurea-surface px-3.5 py-2.5">
      <div className="flex items-center gap-2 text-[11px] text-aurea-ink-3">
        {duration && <span className="font-mono tabular-nums">{duration}</span>}
        {duration && summary && <span className="text-aurea-border-strong">·</span>}
        {!summary && !duration && <span className="italic">No notes captured.</span>}
      </div>
      {summary && (
        <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-[1.55] text-aurea-ink-2">{summary}</p>
      )}
      {entry.recordingUrl && (
        <a
          href={entry.recordingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-aurea-border px-2.5 py-1 text-[11px] font-medium text-aurea-ink-2 transition-colors hover:bg-aurea-canvas"
        >
          <Play className="h-3 w-3" strokeWidth={1.75} /> Recording
          <ChevronRight className="h-3 w-3 text-aurea-ink-3" strokeWidth={1.75} />
        </a>
      )}
    </div>
  )
}
