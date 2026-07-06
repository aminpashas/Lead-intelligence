'use client'

import { useState } from 'react'
import { format } from 'date-fns'
import { Phone, PhoneIncoming, PhoneOutgoing, Bot, User, ChevronDown, ChevronRight, Play } from 'lucide-react'
import type { VoiceCall } from '@/types/database'

const AGENT_LABEL: Record<string, string> = { setter: 'Setter', closer: 'Closer' }

const OUTCOME_LABEL: Record<string, string> = {
  appointment_booked: 'Appointment booked',
  callback_requested: 'Callback requested',
  interested: 'Interested',
  not_interested: 'Not interested',
  no_answer: 'No answer',
  voicemail: 'Voicemail',
  wrong_number: 'Wrong number',
  do_not_call: 'Do not call',
}

type Line = { role: 'agent' | 'lead'; content: string }

/**
 * Parse Retell's plain-text transcript ("Agent: …\nUser: …") into role-tagged
 * lines. Continuation lines (no speaker prefix) attach to the previous line.
 * Falls back to a single block if no speaker prefixes are present.
 */
function parseTranscript(raw: string): Line[] {
  const lines: Line[] = []
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line.trim()) continue
    const agent = line.match(/^(?:agent|ai|assistant)\s*:\s*(.*)$/i)
    const lead = line.match(/^(?:user|caller|lead|patient|customer)\s*:\s*(.*)$/i)
    if (agent) {
      lines.push({ role: 'agent', content: agent[1] })
    } else if (lead) {
      lines.push({ role: 'lead', content: lead[1] })
    } else if (lines.length) {
      lines[lines.length - 1].content += `\n${line}`
    } else {
      lines.push({ role: 'agent', content: line })
    }
  }
  return lines
}

function fmtDuration(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * A completed voice call rendered in the conversation timeline. Collapsed by
 * default (summary line); expands to show the full transcript and recording.
 */
export function CallCard({ call }: { call: VoiceCall }) {
  const [open, setOpen] = useState(false)

  const outbound = call.direction === 'outbound'
  const agentName = AGENT_LABEL[call.agent_type || ''] || 'AI'
  const duration = fmtDuration(call.duration_seconds)
  const when = call.ended_at || call.started_at || call.created_at
  const outcome = call.outcome ? OUTCOME_LABEL[call.outcome] || call.outcome.replace(/_/g, ' ') : null

  const transcriptText =
    typeof call.transcript === 'string'
      ? call.transcript
      : Array.isArray(call.transcript)
        ? (call.transcript as Array<{ role?: string; content?: string }>)
            .map((t) => `${t.role === 'agent' ? 'Agent' : 'User'}: ${t.content ?? ''}`)
            .join('\n')
        : ''
  const lines = transcriptText ? parseTranscript(transcriptText) : []

  return (
    <div className="mx-auto w-full max-w-[540px]">
      <div className="overflow-hidden rounded-2xl border border-aurea-border bg-aurea-surface">
        {/* Summary row (click to expand) */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-aurea-canvas"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-aurea-border bg-aurea-canvas">
            {outbound ? (
              <PhoneOutgoing className="h-3.5 w-3.5 text-aurea-ink-2" strokeWidth={1.75} />
            ) : (
              <PhoneIncoming className="h-3.5 w-3.5 text-aurea-ink-2" strokeWidth={1.75} />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-aurea-ink">
              <span>{outbound ? 'Outbound call' : 'Inbound call'}</span>
              <span className="text-aurea-border-strong">·</span>
              <span className="text-aurea-ink-2">{agentName}</span>
              {duration && (
                <>
                  <span className="text-aurea-border-strong">·</span>
                  <span className="text-aurea-ink-3">{duration}</span>
                </>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-aurea-ink-3">
              <span>{format(new Date(when), 'MMM d, h:mm a')}</span>
              {outcome && (
                <span className="rounded-full border border-aurea-border px-1.5 py-px text-[10px] font-medium capitalize text-aurea-ink-2">
                  {outcome}
                </span>
              )}
            </div>
          </div>
          {lines.length > 0 &&
            (open ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-aurea-ink-3" strokeWidth={1.75} />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-aurea-ink-3" strokeWidth={1.75} />
            ))}
        </button>

        {/* Expanded: summary + transcript + recording */}
        {open && (
          <div className="border-t border-aurea-border px-3.5 py-3">
            {call.transcript_summary && (
              <p className="mb-3 rounded-lg bg-aurea-canvas px-3 py-2 text-[12.5px] leading-[1.5] text-aurea-ink-2">
                {call.transcript_summary}
              </p>
            )}

            {lines.length === 0 ? (
              <p className="text-[12px] italic text-aurea-ink-3">No transcript captured for this call.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {lines.map((l, i) => {
                  const isAgent = l.role === 'agent'
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
                            : 'border border-aurea-border bg-aurea-canvas text-aurea-ink'
                        }`}
                      >
                        <p className="whitespace-pre-wrap">{l.content}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {call.recording_url && (
              <a
                href={call.recording_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-aurea-border px-2.5 py-1 text-[11px] font-medium text-aurea-ink-2 transition-colors hover:bg-aurea-canvas"
              >
                <Play className="h-3 w-3" strokeWidth={1.75} />
                Recording
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
