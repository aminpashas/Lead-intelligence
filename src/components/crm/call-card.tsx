'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { toast } from 'sonner'
import {
  PhoneIncoming,
  PhoneOutgoing,
  Bot,
  User,
  ChevronDown,
  ChevronRight,
  GraduationCap,
  Loader2,
  NotebookPen,
  Sparkles,
  X,
} from 'lucide-react'
import type { VoiceCall } from '@/types/database'
import { CallRecordingPlayer } from '@/components/voice/call-recording-player'
import { recordingPlaybackUrl } from '@/lib/voice/recording-playback'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

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

type TrainingState =
  | { phase: 'idle' }
  | { phase: 'working' }
  | { phase: 'added'; count: number }
  | { phase: 'transcribing' }
  | { phase: 'error'; message: string }

/**
 * Admin-only "Use for AI training" control. Sends the call to
 * /api/voice/calls/[id]/train, which distills it into the org's AI knowledge
 * base (the same entries injected into live agent prompts). Shows the
 * persisted state from the call row and tracks transitions locally.
 */
function TrainingControl({ call }: { call: VoiceCall }) {
  const [state, setState] = useState<TrainingState>(() =>
    call.training_status === 'added'
      ? { phase: 'added', count: (call.training_item_ids ?? []).length }
      : { phase: 'idle' }
  )

  const run = async () => {
    setState({ phase: 'working' })
    try {
      const res = await fetch(`/api/voice/calls/${call.id}/train`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (res.status === 202) {
        setState({ phase: 'transcribing' })
      } else if (res.ok) {
        setState({ phase: 'added', count: (body.items ?? []).length })
      } else {
        setState({ phase: 'error', message: body.error || 'Something went wrong — try again.' })
      }
    } catch {
      setState({ phase: 'error', message: 'Network error — try again.' })
    }
  }

  const undo = async () => {
    setState({ phase: 'working' })
    try {
      const res = await fetch(`/api/voice/calls/${call.id}/train`, { method: 'DELETE' })
      setState(res.ok ? { phase: 'idle' } : { phase: 'error', message: 'Could not remove — try again.' })
    } catch {
      setState({ phase: 'error', message: 'Network error — try again.' })
    }
  }

  if (state.phase === 'added') {
    return (
      <div className="mt-3 flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-aurea-emerald/30 bg-aurea-emerald/10 px-2.5 py-1 text-[11px] font-medium text-aurea-emerald">
          <GraduationCap className="h-3 w-3" strokeWidth={1.75} />
          In AI knowledge base{state.count > 0 ? ` · ${state.count} item${state.count === 1 ? '' : 's'}` : ''}
        </span>
        <button
          type="button"
          onClick={undo}
          aria-label="Remove from AI training"
          className="inline-flex items-center gap-1 rounded-full px-1.5 py-1 text-[11px] text-aurea-ink-3 transition-colors hover:text-aurea-ink-2"
        >
          <X className="h-3 w-3" strokeWidth={1.75} /> Undo
        </button>
      </div>
    )
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={run}
        disabled={state.phase === 'working'}
        className="inline-flex items-center gap-1.5 rounded-full border border-aurea-border bg-aurea-canvas px-2.5 py-1 text-[11px] font-medium text-aurea-ink-2 transition-colors enabled:hover:bg-aurea-surface-2 disabled:opacity-60"
      >
        {state.phase === 'working' ? (
          <Loader2 className="h-3 w-3 animate-spin" strokeWidth={1.75} />
        ) : (
          <GraduationCap className="h-3 w-3" strokeWidth={1.75} />
        )}
        {state.phase === 'working' ? 'Analyzing call…' : 'Use for AI training'}
      </button>
      {state.phase === 'transcribing' && (
        <p className="mt-1.5 text-[11px] text-aurea-ink-3">
          Transcribing the recording — try again in a minute.
        </p>
      )}
      {state.phase === 'error' && (
        <p className="mt-1.5 text-[11px] text-aurea-rose">{state.message}</p>
      )}
    </div>
  )
}

// ── Coaching output renderers ───────────────────────────────────────────────
// The shape shared by a fresh conversation-analyst result and a persisted
// conversation_analyses row (the coach route returns whichever it has).
type CoachData = {
  coaching_notes?: string | null
  things_done_well?: string[] | null
  improvement_areas?: string[] | null
}

function PointList({ title, items, tone }: { title: string; items: string[]; tone: 'primary' | 'amber' }) {
  return (
    <div>
      <div className={`aurea-eyebrow mb-1.5 ${tone === 'primary' ? '!text-aurea-primary' : '!text-aurea-amber'}`}>
        {title}
      </div>
      <ul className="space-y-1 text-[12px] leading-relaxed text-aurea-ink-2">
        {items.map((p, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-aurea-ink-3">&mdash;</span>
            <span>{p}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function CoachingResult({ data }: { data: CoachData }) {
  const doneWell = data.things_done_well ?? []
  const improve = data.improvement_areas ?? []
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-aurea-border bg-aurea-canvas px-3 py-3">
      {data.coaching_notes && (
        <div className="border-l-2 border-aurea-gold py-0.5 pl-3">
          <div className="aurea-eyebrow mb-1">Coaching Notes</div>
          <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-aurea-ink-2">
            {data.coaching_notes}
          </p>
        </div>
      )}
      {(doneWell.length > 0 || improve.length > 0) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {doneWell.length > 0 && <PointList title="Done Well" items={doneWell} tone="primary" />}
          {improve.length > 0 && <PointList title="Improve" items={improve} tone="amber" />}
        </div>
      )}
    </div>
  )
}

type CoachState =
  | { phase: 'idle' }
  | { phase: 'working' }
  | { phase: 'ready'; data: CoachData }
  | { phase: 'error'; message: string }

/**
 * "Coach this call" — runs the conversation analyst over a HUMAN call's stored
 * transcript and shows what the staffer did well + where to improve. Only
 * rendered for staff calls that actually have a transcript (AI calls already get
 * graded turn-by-turn in the Conversations "Analyze" flow).
 */
function CoachingControl({ call }: { call: VoiceCall }) {
  const [state, setState] = useState<CoachState>({ phase: 'idle' })

  const run = async () => {
    setState({ phase: 'working' })
    try {
      const res = await fetch(`/api/voice/calls/${call.id}/coach`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (res.ok && body.analysis) {
        setState({ phase: 'ready', data: body.analysis as CoachData })
      } else {
        setState({ phase: 'error', message: body.error || 'Something went wrong — try again.' })
      }
    } catch {
      setState({ phase: 'error', message: 'Network error — try again.' })
    }
  }

  return (
    <div className="mt-3">
      {state.phase !== 'ready' && (
        <button
          type="button"
          onClick={run}
          disabled={state.phase === 'working'}
          className="inline-flex items-center gap-1.5 rounded-full border border-aurea-border bg-aurea-canvas px-2.5 py-1 text-[11px] font-medium text-aurea-ink-2 transition-colors enabled:hover:bg-aurea-surface-2 disabled:opacity-60"
        >
          {state.phase === 'working' ? (
            <Loader2 className="h-3 w-3 animate-spin" strokeWidth={1.75} />
          ) : (
            <Sparkles className="h-3 w-3" strokeWidth={1.75} />
          )}
          {state.phase === 'working' ? 'Coaching this call…' : 'Coach this call'}
        </button>
      )}
      {state.phase === 'ready' && <CoachingResult data={state.data} />}
      {state.phase === 'error' && <p className="mt-1.5 text-[11px] text-aurea-rose">{state.message}</p>}
    </div>
  )
}

/**
 * A completed voice call rendered in the conversation timeline. Collapsed by
 * default (summary line); expands to show the full transcript and recording.
 * `canTrainAi` (admin roles only — set by the server page) reveals the
 * "Use for AI training" control.
 */
export function CallCard({ call, canTrainAi = false }: { call: VoiceCall; canTrainAi?: boolean }) {
  const [open, setOpen] = useState(false)
  const [editingNotes, setEditingNotes] = useState(false)
  const [noteDraft, setNoteDraft] = useState(call.outcome_notes ?? '')
  const [savingNotes, setSavingNotes] = useState(false)
  const router = useRouter()

  function beginEditNotes() {
    setNoteDraft(call.outcome_notes ?? '')
    setEditingNotes(true)
    setOpen(true)
  }

  async function saveNotes() {
    if (savingNotes) return
    setSavingNotes(true)
    try {
      const res = await fetch(`/api/voice/calls/${call.id}/disposition`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: noteDraft.trim() }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to save notes')
      setEditingNotes(false)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save notes')
    } finally {
      setSavingNotes(false)
    }
  }

  const outbound = call.direction === 'outbound'
  // A browser/bridge call is placed by a human; only an actual AI leg is labelled "AI".
  const human = call.call_mode === 'browser' || call.call_mode === 'bridge'
  const agentName = AGENT_LABEL[call.agent_type || ''] || (human ? 'Staff' : 'AI')
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
  // Human calls carry no AI transcript — the composed summary (and the staffer's
  // notes it folds in) is the content, so the card must still expand to reveal
  // it. A recording alone is also worth expanding for (listen + train).
  const expandable = lines.length > 0 || !!call.transcript_summary || !!call.recording_url

  return (
    <div className="group/call mx-auto w-full max-w-[540px]">
      {/* Right-click anywhere on the card to amend the notes — for a call the
          staffer didn't get to disposition at the time. A hover "Edit notes"
          button mirrors it, so the action is discoverable and reachable without
          a right mouse button (trackpads, touch). */}
      <ContextMenu>
        <ContextMenuTrigger
          render={<div className="relative overflow-hidden rounded-2xl border border-aurea-border bg-aurea-surface" />}
        >
        {/* Summary row (click to expand) */}
        <button
          type="button"
          onClick={() => expandable && setOpen((v) => !v)}
          disabled={!expandable}
          className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors enabled:hover:bg-aurea-canvas disabled:cursor-default"
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
          {expandable &&
            (open ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-aurea-ink-3" strokeWidth={1.75} />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-aurea-ink-3" strokeWidth={1.75} />
            ))}
        </button>

        {/* Visible twin of the right-click action. Rendered as a sibling of the
            expand button rather than inside it — a button cannot nest a button. */}
        <div className="pointer-events-none absolute right-9 top-2.5 opacity-0 transition-opacity group-hover/call:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={beginEditNotes}
            title="Edit call notes"
            aria-label="Edit call notes"
            className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded text-aurea-ink-3 transition-colors hover:bg-aurea-surface-2 hover:text-aurea-ink"
          >
            <NotebookPen className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>

        {/* Expanded: summary + transcript + recording */}
        {open && (
          <div className="border-t border-aurea-border px-3.5 py-3">
            {call.transcript_summary && (
              <p className="mb-3 rounded-lg bg-aurea-canvas px-3 py-2 text-[12.5px] leading-[1.5] text-aurea-ink-2">
                {call.transcript_summary}
              </p>
            )}

            {/* Staff notes — editable in place, for a call nobody dispositioned
                at the time. Saving records the previous text to the audit trail. */}
            {editingNotes ? (
              <div className="mb-3 space-y-2">
                <Textarea
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  autoFocus
                  placeholder="What happened on this call?"
                  className="resize-none text-[12.5px]"
                />
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => setEditingNotes(false)} className="gap-1">
                    <X className="h-3 w-3" strokeWidth={1.75} />
                    Cancel
                  </Button>
                  <Button size="sm" onClick={saveNotes} disabled={savingNotes} className="gap-1">
                    {savingNotes ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    Save notes
                  </Button>
                </div>
              </div>
            ) : call.outcome_notes ? (
              <div className="mb-3 rounded-lg border-l-2 border-aurea-primary/50 bg-aurea-canvas px-3 py-2">
                <p className="mb-0.5 text-[10px] uppercase tracking-wide text-aurea-ink-3">Staff notes</p>
                <p className="whitespace-pre-wrap text-[12.5px] leading-[1.5] text-aurea-ink-2">
                  {call.outcome_notes}
                </p>
              </div>
            ) : null}

            {lines.length === 0 ? (
              call.transcript_summary ? null : (
                <p className="text-[12px] italic text-aurea-ink-3">No transcript captured for this call.</p>
              )
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
              <div className="mt-3">
                <CallRecordingPlayer
                  url={recordingPlaybackUrl(call.id, call.recording_url)!}
                  size="compact"
                />
              </div>
            )}

            {/* Coach a human call from its transcript. AI calls are graded
                turn-by-turn in the Conversations "Analyze" flow already. */}
            {human && lines.length >= 2 && <CoachingControl call={call} />}

            {canTrainAi && <TrainingControl call={call} />}
          </div>
        )}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={beginEditNotes}>
            <NotebookPen className="h-3.5 w-3.5" strokeWidth={1.75} />
            {call.outcome_notes ? 'Edit call notes' : 'Add call notes'}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}
