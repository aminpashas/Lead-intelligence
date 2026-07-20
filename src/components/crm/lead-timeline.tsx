'use client'

import { type ReactNode } from 'react'
import Link from 'next/link'
import { DEFAULT_PRACTICE_TIMEZONE, zonedDateLabel, zonedTimeLabel, zonedDateTimeLabel } from '@/lib/time/zoned'
import {
  PhoneIncoming, PhoneOutgoing,
  StickyNote, GitBranch, Sparkles, User,
} from 'lucide-react'
import { channelLabel } from '@/lib/channels'
import { ChannelIcon } from '@/components/crm/channel-icon'
import type { TimelineEntry } from '@/lib/timeline/types'
import { entryActor, type TimelineActor } from '@/lib/timeline/actor'
import { CallRecordingPlayer } from '@/components/voice/call-recording-player'
import { recordingPlaybackUrl } from '@/lib/voice/recording-playback'


/** Optional per-entry decorations. Only the org-wide activity monitor supplies
 *  these — the per-conversation timeline passes neither and renders as before.
 *  `hrefFor` returning a string makes the whole node a link to its source;
 *  `metaFor` injects extra header content (e.g. the lead-name chip). */
export type TimelineDecorations = {
  hrefFor?: (entry: TimelineEntry) => string | null
  metaFor?: (entry: TimelineEntry) => ReactNode
}

/** Small badge naming the team member or AI agent behind an event. */
function ActorChip({ actor }: { actor: TimelineActor }) {
  const Icon = actor.kind === 'ai' ? Sparkles : User
  const tone = actor.kind === 'ai' ? 'text-aurea-primary' : 'text-aurea-ink-3'
  return (
    <span className={`inline-flex items-center gap-1 text-[10.5px] font-medium ${tone}`}>
      <Icon className="h-2.5 w-2.5" strokeWidth={2} />
      {actor.name}
    </span>
  )
}

/** Presentational feed — the elevated timeline rendering, no actions or state.
 *  Shared by the lead detail, the conversations page and the activity monitor. */
export function TimelineFeed({
  entries,
  timeZone = DEFAULT_PRACTICE_TIMEZONE,
  decorations,
  userNameById,
}: { entries: TimelineEntry[]; timeZone?: string; decorations?: TimelineDecorations; userNameById?: Map<string, string> }) {
  return <DetailedTimeline entries={entries} timeZone={timeZone} decorations={decorations} userNameById={userNameById} />
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

function DetailedTimeline({ entries, timeZone, decorations, userNameById }: { entries: TimelineEntry[]; timeZone: string; decorations?: TimelineDecorations; userNameById?: Map<string, string> }) {
  return (
    <div className="relative pl-9">
      {/* The spine — one hairline the whole column hangs from. */}
      <div className="absolute bottom-2 left-[14px] top-2 w-px bg-aurea-border" aria-hidden />
      <ol className="space-y-5">
        {entries.map((entry) => {
          const href = decorations?.hrefFor?.(entry) ?? null
          const meta = decorations?.metaFor?.(entry)
          const actor = entryActor(entry, userNameById)
          return (
          <li key={`${entry.kind}-${entry.id}`} className="relative">
            {/* Node marker sitting on the spine */}
            <span
              className={`absolute -left-9 top-0 flex h-7 w-7 items-center justify-center rounded-full border bg-aurea-surface ${nodeTone(entry)}`}
            >
              <NodeIcon entry={entry} />
            </span>

            {/* Stretched link: an overlay anchor covers the whole node so a
                click anywhere navigates, while interactive body controls (the
                recording player) sit above it and stay usable. */}
            {href && (
              <Link
                href={href}
                aria-label={`Open ${typeLabel(entry)} in conversations`}
                className="absolute inset-0 z-[1] rounded-lg -mx-2 -my-1 transition-colors hover:bg-aurea-surface-2/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-aurea-primary/40"
              />
            )}
            <div className="relative">
              {/* Header line: type · who · badges · time */}
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="aurea-eyebrow leading-none">{typeLabel(entry)}</span>
                {meta}
                {actor && <ActorChip actor={actor} />}
                {entry.kind === 'call' && entry.outcome && (
                  <span className="rounded-full border border-aurea-border px-1.5 py-px text-[10px] font-medium capitalize text-aurea-ink-2">
                    {entry.outcome.replace(/_/g, ' ')}
                  </span>
                )}
                <span className="ml-auto font-mono text-[11px] tabular-nums text-aurea-ink-3" title={zonedDateTimeLabel(new Date(entry.at), timeZone)}>
                  {zonedDateLabel(new Date(entry.at), timeZone)} · {zonedTimeLabel(new Date(entry.at), timeZone)}
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
            </div>
          </li>
          )
        })}
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
    return <ChannelIcon channel={entry.channel} className="h-3.5 w-3.5" tinted />
  }
  if (entry.kind === 'note') return <StickyNote className="h-3.5 w-3.5" strokeWidth={1.75} />
  return <GitBranch className="h-3.5 w-3.5" strokeWidth={1.75} />
}

function typeLabel(entry: TimelineEntry): string {
  if (entry.kind === 'message') {
    // Registry-driven: a Messenger DM used to read as a generic "Message" here.
    return `${entry.direction === 'outbound' ? 'Sent' : 'Received'} · ${channelLabel(entry.channel)}`
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
        // `relative z-[2]` keeps the player above the monitor's stretched-link
        // overlay (z-[1]); a no-op in the plain timeline where there's no overlay.
        <div className="relative z-[2] mt-2">
          <CallRecordingPlayer
            url={recordingPlaybackUrl(entry.id, entry.recordingUrl)!}
            size="compact"
          />
        </div>
      )}
    </div>
  )
}
