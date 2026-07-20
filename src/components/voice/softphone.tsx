'use client'

/**
 * Softphone — the floating call widget, mounted once in the dashboard shell.
 *
 * It renders nothing while idle. During a call it shows the live controls (mute,
 * keypad, hold, hang up, timer) alongside a notes field the staffer can fill as they
 * talk — plus, for a manual dial to an unknown number, a capture-the-contact form.
 * When the call ends the widget stays open on the same notes/contact so the staffer
 * can finish writing them up and pick an outcome. Picking an outcome is MANDATORY:
 * there is no skip/dismiss and no pre-selected default, so every call is logged with
 * the staffer's real disposition — the disposition route uses it to decide whether
 * the call counts as actual contact (a voicemail must not move a lead's stage).
 * All call state comes from useSoftphone(); the notes/contact drafts live here and
 * survive the in-call → ended transition because this component never unmounts
 * between them.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Phone, PhoneOff, Mic, MicOff, Grid3x3, Pause, Play, Loader2, Check, Plus, Maximize2, Minimize2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useSoftphone } from './softphone-provider'

/** A single note the staffer submitted, stamped with the moment they clicked Submit. */
type LoggedNote = { at: string; text: string }

/** What a successful disposition save tells us about where the call landed. */
type SaveResult = { leadId: string | null; leadCreated: boolean }

/** The clock time a note was submitted, in the staffer's local time (e.g. "3:45 PM"). */
function stampTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * Fold the submitted-note log (+ any still-unsubmitted draft) into the single text
 * body the disposition endpoint persists. Each committed note becomes its own
 * `[3:45 PM] …` line; a trailing draft is included unstamped so nothing is lost on a
 * final save that skipped the Submit button.
 */
function composeNotes(log: LoggedNote[], draft = ''): string {
  const lines = log.map((e) => `[${stampTime(e.at)}] ${e.text}`)
  const trailing = draft.trim()
  if (trailing) lines.push(trailing)
  return lines.join('\n')
}

const DTMF = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']

// Staff-facing outcomes. Values match voice_calls.outcome / the disposition route.
const OUTCOMES: { value: string; label: string }[] = [
  { value: 'appointment_booked', label: 'Booked appt' },
  { value: 'interested', label: 'Interested' },
  { value: 'callback_requested', label: 'Callback' },
  { value: 'voicemail_left', label: 'Left voicemail' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'not_interested', label: 'Not interested' },
  { value: 'wrong_number', label: 'Wrong number' },
  { value: 'do_not_call', label: 'Do not call' },
]

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function Softphone() {
  const router = useRouter()
  const {
    status,
    activeLead,
    muted,
    held,
    callSeconds,
    endedCall,
    needsContact,
    hangup,
    toggleMute,
    toggleHold,
    sendDigit,
    clearEnded,
  } = useSoftphone()
  const [showKeypad, setShowKeypad] = useState(false)
  // The outcome the staffer has picked but not yet saved. Deliberately starts null
  // with no default — the staffer must make an explicit choice before Save & close
  // unlocks, so a call can never be logged with an outcome nobody chose.
  const [selectedOutcome, setSelectedOutcome] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [submittingNote, setSubmittingNote] = useState(false)
  // Bigger panel when the staffer wants more room to write. Persists across the
  // in-call → ended transition (a per-staffer preference, not per-call).
  const [expanded, setExpanded] = useState(false)

  // Drafts the staffer fills while talking — persisted through call end.
  const [notes, setNotes] = useState('')
  // Notes the staffer has committed with the Submit button, each time-stamped.
  const [noteLog, setNoteLog] = useState<LoggedNote[]>([])
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')

  const inCall = status === 'connecting' || status === 'ringing' || status === 'in_call'

  // Reset the drafts when a brand-new call begins (activeLead flips to a fresh one
  // while nothing is awaiting disposition).
  useEffect(() => {
    if (inCall && !endedCall) {
      setNotes('')
      setNoteLog([])
      setFirstName('')
      setLastName('')
      setEmail('')
      setSelectedOutcome(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLead?.id])

  // Whether to show the capture-the-contact form: live-call flag during the call,
  // the snapshotted flag once it has ended.
  const showContactForm = inCall ? needsContact : !!endedCall?.needsContact

  const buildContact = useCallback(() => {
    const first = firstName.trim()
    if (!first) return undefined
    return {
      first_name: first,
      last_name: lastName.trim() || undefined,
      email: email.trim() || undefined,
    }
  }, [firstName, lastName, email])

  // Persist the write-up. `outcome` is optional — a bare "Save" keeps notes/contact
  // without forcing a disposition. `notesToSave` is the composed note body (log +
  // trailing draft). Returns the saved call's lead linkage on success (and whether a
  // new contact was minted) so callers can tell the staffer exactly where it landed;
  // null on failure.
  const save = useCallback(
    async (outcome?: string, notesToSave?: string): Promise<SaveResult | null> => {
      if (!endedCall) return null
      const body: Record<string, unknown> = {
        duration_seconds: endedCall.durationSeconds,
      }
      if (outcome) body.outcome = outcome
      const trimmed = notesToSave?.trim()
      if (trimmed) body.notes = trimmed
      const contact = buildContact()
      if (showContactForm && contact) body.contact = contact

      try {
        const res = await fetch(`/api/voice/calls/${endedCall.callId}/disposition`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error('Failed to save')
        const data = await res.json().catch(() => ({}))
        return {
          leadId: typeof data?.lead_id === 'string' ? data.lead_id : null,
          leadCreated: data?.lead_created === true,
        }
      } catch {
        toast.error('Could not save the call')
        return null
      }
    },
    [endedCall, buildContact, showContactForm]
  )

  // Success toast that names where the call landed. When a contact was minted, say
  // so and deep-link it; when it attached to a known lead, offer to open it; only
  // fall back to the bare label when there's no lead to point at.
  const notifySaved = useCallback(
    (result: SaveResult, label: string) => {
      const name = `${firstName.trim()} ${lastName.trim()}`.trim()
      if (result.leadCreated && result.leadId) {
        toast.success(`New contact created${name ? `: ${name}` : ''}`, {
          description: 'A new lead was added from this call.',
          action: { label: 'View', onClick: () => router.push(`/leads/${result.leadId}`) },
        })
      } else if (result.leadId) {
        toast.success(label, {
          action: { label: 'View lead', onClick: () => router.push(`/leads/${result.leadId}`) },
        })
      } else {
        toast.success(label)
      }
    },
    [firstName, lastName, router]
  )

  // Commit the current draft as a time-stamped note. During a live call there is no
  // call id yet, so it just accumulates locally and flushes on call end; once the
  // call has ended each submit also persists immediately.
  const submitNote = useCallback(async () => {
    const text = notes.trim()
    if (!text) return
    const nextLog = [...noteLog, { at: new Date().toISOString(), text }]
    setNoteLog(nextLog)
    setNotes('')
    if (endedCall) {
      setSubmittingNote(true)
      const result = await save(undefined, composeNotes(nextLog))
      setSubmittingNote(false)
      if (result) toast.success('Note added')
    }
  }, [notes, noteLog, endedCall, save])

  // The only way out of the ended panel: an outcome MUST be selected first. This is
  // what stops "close the widget, never log the call" — and, downstream, what
  // stops a voicemail-only call silently counting as real contact.
  async function saveAndClose() {
    if (!selectedOutcome) return
    setSaving(true)
    const result = await save(selectedOutcome, composeNotes(noteLog, notes))
    setSaving(false)
    if (result) {
      notifySaved(result, 'Call logged')
      setSelectedOutcome(null)
      clearEnded()
      router.refresh()
    }
  }

  const busy = saving || submittingNote

  // Nothing to show when idle and no call is awaiting disposition.
  if (!inCall && !endedCall) return null

  const leadName = activeLead
    ? `${activeLead.first_name}${activeLead.last_name ? ` ${activeLead.last_name}` : ''}`
    : endedCall
      ? `${endedCall.lead.first_name}${endedCall.lead.last_name ? ` ${endedCall.lead.last_name}` : ''}`
      : 'Lead'

  const statusLabel =
    status === 'connecting'
      ? 'Connecting…'
      : status === 'ringing'
        ? 'Ringing…'
        : status === 'in_call'
          ? held
            ? `On hold · ${fmt(callSeconds)}`
            : fmt(callSeconds)
          : ''

  // Grow/shrink the panel, shared between the in-call and ended headers.
  const expandButton = (
    <button
      onClick={() => setExpanded((v) => !v)}
      title={expanded ? 'Shrink' : 'Expand'}
      className="flex h-7 w-7 items-center justify-center rounded-full text-aurea-ink-3 hover:bg-aurea-surface-2"
    >
      {expanded ? (
        <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.75} />
      ) : (
        <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.75} />
      )}
    </button>
  )

  // Contact form + notes editor, shared between the in-call and ended panels.
  const writeUp = (
    <div className="mt-4 space-y-3">
      {showContactForm && (
        <div className="rounded-xl border border-aurea-border bg-aurea-canvas/60 p-2.5">
          <p className="mb-1.5 text-[11px] font-medium text-aurea-ink-2">Who did you reach?</p>
          <div className="grid grid-cols-2 gap-1.5">
            <input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="First name"
              className="rounded-lg border border-aurea-border bg-aurea-surface px-2.5 py-1.5 text-sm text-aurea-ink placeholder:text-aurea-ink-3 focus:border-aurea-primary focus:outline-none"
            />
            <input
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="Last name"
              className="rounded-lg border border-aurea-border bg-aurea-surface px-2.5 py-1.5 text-sm text-aurea-ink placeholder:text-aurea-ink-3 focus:border-aurea-primary focus:outline-none"
            />
          </div>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            placeholder="Email (optional)"
            className="mt-1.5 w-full rounded-lg border border-aurea-border bg-aurea-surface px-2.5 py-1.5 text-sm text-aurea-ink placeholder:text-aurea-ink-3 focus:border-aurea-primary focus:outline-none"
          />
        </div>
      )}

      <div>
        <label className="mb-1.5 block text-[11px] font-medium text-aurea-ink-2">Call notes</label>

        {noteLog.length > 0 && (
          <ul className="mb-2 space-y-1">
            {noteLog.map((entry, i) => (
              <li
                key={`${entry.at}-${i}`}
                className="rounded-lg bg-aurea-canvas/60 px-2.5 py-1.5 text-xs leading-[1.5] text-aurea-ink"
              >
                <span className="mr-1.5 tabular-nums text-aurea-ink-3">{stampTime(entry.at)}</span>
                {entry.text}
              </li>
            ))}
          </ul>
        )}

        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter submits the note without reaching for the button.
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              void submitNote()
            }
          }}
          rows={expanded ? 8 : 3}
          placeholder="What was discussed, next steps…"
          className="w-full resize-none rounded-lg border border-aurea-border bg-aurea-surface px-2.5 py-2 text-sm leading-[1.5] text-aurea-ink placeholder:text-aurea-ink-3 focus:border-aurea-primary focus:outline-none"
        />
        <button
          onClick={() => void submitNote()}
          disabled={!notes.trim() || submittingNote}
          className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-aurea-border py-1.5 text-xs font-medium text-aurea-ink transition-colors hover:bg-aurea-surface-2 disabled:opacity-50"
        >
          {submittingNote ? (
            <Loader2 className="h-3 w-3 animate-spin" strokeWidth={1.75} />
          ) : (
            <Plus className="h-3 w-3" strokeWidth={2} />
          )}
          Submit note
        </button>
      </div>
    </div>
  )

  return (
    <div
      className={cn(
        // Phone: edge-to-edge card above the home indicator. The desktop
        // expanded width (32rem = 512px) overflows every phone, so width is
        // only applied from `sm` up — on mobile the panel is always full-bleed
        // and the expand toggle just reveals more rows.
        // z-30 (not z-50) so an open nav drawer, whose backdrop is z-40, covers
        // the softphone instead of losing to it on DOM order.
        // Below lg the shell renders the BottomNav (3.5rem + safe-area), so the
        // panel anchors above it; lg+ has no bottom bar and reverts to bottom-4.
        'fixed inset-x-2 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)] z-30 flex max-h-[calc(100dvh-5rem)] flex-col overflow-hidden rounded-2xl border border-aurea-border bg-aurea-surface shadow-2xl transition-[width] duration-200',
        'sm:inset-x-auto sm:right-4 sm:max-h-[calc(100dvh-6rem)] lg:bottom-4 lg:max-h-[calc(100dvh-2rem)]',
        expanded ? 'sm:w-[32rem]' : 'sm:w-[22rem]'
      )}
    >
      {/* ── Live call ─────────────────────────────────────────────── */}
      {inCall && (
        <div className="overflow-y-auto p-4">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-full',
                status === 'in_call' && held
                  ? 'bg-amber-500/15 text-amber-500'
                  : status === 'in_call'
                    ? 'bg-emerald-500/15 text-emerald-500'
                    : 'bg-aurea-surface-2 text-aurea-ink-2'
              )}
            >
              <Phone className="h-4 w-4" strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-aurea-ink">{leadName}</p>
              <p className="text-xs tabular-nums text-aurea-ink-3">{statusLabel}</p>
            </div>
            {expandButton}
          </div>

          {showKeypad && status === 'in_call' && (
            <div className="mt-3 grid grid-cols-3 gap-1.5">
              {DTMF.map((d) => (
                <button
                  key={d}
                  onClick={() => sendDigit(d)}
                  className="rounded-lg border border-aurea-border py-2 text-sm font-medium text-aurea-ink transition-colors hover:bg-aurea-surface-2"
                >
                  {d}
                </button>
              ))}
            </div>
          )}

          <div className="mt-4 flex items-center justify-between">
            <button
              onClick={toggleMute}
              disabled={status !== 'in_call'}
              title={muted ? 'Unmute' : 'Mute'}
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-full border transition-colors disabled:opacity-40',
                muted ? 'border-aurea-rose/30 bg-aurea-rose/10 text-aurea-rose' : 'border-aurea-border text-aurea-ink hover:bg-aurea-surface-2'
              )}
            >
              {muted ? <MicOff className="h-4 w-4" strokeWidth={1.75} /> : <Mic className="h-4 w-4" strokeWidth={1.75} />}
            </button>

            <button
              onClick={toggleHold}
              disabled={status !== 'in_call'}
              title={held ? 'Resume' : 'Hold'}
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-full border transition-colors disabled:opacity-40',
                held ? 'border-amber-500/30 bg-amber-500/10 text-amber-500' : 'border-aurea-border text-aurea-ink hover:bg-aurea-surface-2'
              )}
            >
              {held ? <Play className="h-4 w-4" strokeWidth={1.75} /> : <Pause className="h-4 w-4" strokeWidth={1.75} />}
            </button>

            <button
              onClick={() => setShowKeypad((v) => !v)}
              disabled={status !== 'in_call'}
              title="Keypad"
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-full border transition-colors disabled:opacity-40',
                showKeypad ? 'border-aurea-border bg-aurea-surface-2 text-aurea-ink' : 'border-aurea-border text-aurea-ink hover:bg-aurea-surface-2'
              )}
            >
              <Grid3x3 className="h-4 w-4" strokeWidth={1.75} />
            </button>

            <button
              onClick={hangup}
              title="Hang up"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500 text-white transition-colors hover:bg-red-600"
            >
              <PhoneOff className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>

          {/* Take notes / capture the contact while the call is live. */}
          {writeUp}
        </div>
      )}

      {/* ── Disposition (call ended) ──────────────────────────────── */}
      {!inCall && endedCall && (
        <div className="overflow-y-auto p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-aurea-ink">Call ended</p>
              <p className="text-xs text-aurea-ink-3">
                {leadName} · {fmt(endedCall.durationSeconds)}
              </p>
            </div>
            {/* No skip/close control here on purpose: the call log cannot be
                dismissed until an outcome is chosen and saved. */}
            <div className="flex items-center gap-0.5">{expandButton}</div>
          </div>

          {/* Same notes + contact editor the staffer had during the call. */}
          {writeUp}

          <p className="mt-4 text-xs font-medium text-aurea-ink-2">How did it go?</p>
          {/* Radio-style selection with NO default: the check lives on whatever the
              staffer picked, never on a pre-anointed option, so nothing reads as
              "Booked appt unless you say otherwise". */}
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {OUTCOMES.map((o) => {
              const selected = selectedOutcome === o.value
              return (
                <button
                  key={o.value}
                  onClick={() => setSelectedOutcome(o.value)}
                  disabled={busy}
                  aria-pressed={selected}
                  className={cn(
                    'flex items-center justify-center gap-1 rounded-lg border px-2 py-2 text-xs font-medium transition-colors disabled:opacity-50',
                    selected
                      ? 'border-aurea-primary bg-aurea-primary/10 text-aurea-ink'
                      : 'border-aurea-border text-aurea-ink hover:bg-aurea-surface-2'
                  )}
                >
                  {selected && <Check className="h-3 w-3 text-aurea-primary" strokeWidth={2} />}
                  {o.label}
                </button>
              )
            })}
          </div>

          {/* Locked until an outcome is chosen — the only exit from this panel. */}
          <button
            onClick={saveAndClose}
            disabled={busy || !selectedOutcome}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-aurea-primary py-2 text-xs font-semibold text-white transition-colors hover:bg-aurea-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving && <Loader2 className="h-3 w-3 animate-spin" strokeWidth={1.75} />}
            Save &amp; close
          </button>
          {!selectedOutcome && (
            <p className="mt-1.5 text-center text-[11px] text-aurea-ink-3">
              Select an outcome to log this call.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
