'use client'

/**
 * Softphone — the floating call widget, mounted once in the dashboard shell.
 *
 * It renders nothing while idle. During a call it shows the live controls (mute,
 * keypad, hold, hang up, timer) alongside a notes field the staffer can fill as they
 * talk — plus, for a manual dial to an unknown number, a capture-the-contact form.
 * When the call ends the widget stays open on the same notes/contact so the staffer
 * can finish writing them up and pick an outcome. All call state comes from
 * useSoftphone(); the notes/contact drafts live here and survive the in-call → ended
 * transition because this component never unmounts between them.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Phone, PhoneOff, Mic, MicOff, Grid3x3, Pause, Play, X, Loader2, Check } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useSoftphone } from './softphone-provider'

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
  const [savingOutcome, setSavingOutcome] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Drafts the staffer fills while talking — persisted through call end.
  const [notes, setNotes] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')

  const inCall = status === 'connecting' || status === 'ringing' || status === 'in_call'

  // Reset the drafts when a brand-new call begins (activeLead flips to a fresh one
  // while nothing is awaiting disposition).
  useEffect(() => {
    if (inCall && !endedCall) {
      setNotes('')
      setFirstName('')
      setLastName('')
      setEmail('')
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
  // without forcing a disposition. Returns true on success so callers can close.
  const save = useCallback(
    async (outcome?: string): Promise<boolean> => {
      if (!endedCall) return false
      const body: Record<string, unknown> = {
        duration_seconds: endedCall.durationSeconds,
      }
      if (outcome) body.outcome = outcome
      if (notes.trim()) body.notes = notes.trim()
      const contact = buildContact()
      if (showContactForm && contact) body.contact = contact

      try {
        const res = await fetch(`/api/voice/calls/${endedCall.callId}/disposition`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error('Failed to save')
        return true
      } catch {
        toast.error('Could not save the call')
        return false
      }
    },
    [endedCall, notes, buildContact, showContactForm]
  )

  async function disposition(outcome: string) {
    setSavingOutcome(outcome)
    const ok = await save(outcome)
    setSavingOutcome(null)
    if (ok) {
      toast.success('Call logged')
      clearEnded()
      router.refresh()
    }
  }

  async function saveAndClose() {
    setSaving(true)
    const ok = await save()
    setSaving(false)
    if (ok) {
      toast.success('Call saved')
      clearEnded()
      router.refresh()
    }
  }

  const busy = savingOutcome !== null || saving

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
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="What was discussed, next steps…"
          className="w-full resize-none rounded-lg border border-aurea-border bg-aurea-surface px-2.5 py-2 text-sm leading-[1.5] text-aurea-ink placeholder:text-aurea-ink-3 focus:border-aurea-primary focus:outline-none"
        />
      </div>
    </div>
  )

  return (
    <div className="fixed bottom-4 right-4 z-50 flex max-h-[calc(100vh-2rem)] w-[22rem] flex-col overflow-hidden rounded-2xl border border-aurea-border bg-aurea-surface shadow-2xl">
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
            <button
              onClick={clearEnded}
              disabled={busy}
              title="Skip"
              className="flex h-7 w-7 items-center justify-center rounded-full text-aurea-ink-3 hover:bg-aurea-surface-2 disabled:opacity-50"
            >
              <X className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>

          {/* Same notes + contact editor the staffer had during the call. */}
          {writeUp}

          <p className="mt-4 text-xs font-medium text-aurea-ink-2">How did it go?</p>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {OUTCOMES.map((o) => (
              <button
                key={o.value}
                onClick={() => disposition(o.value)}
                disabled={busy}
                className="flex items-center justify-center gap-1 rounded-lg border border-aurea-border px-2 py-2 text-xs font-medium text-aurea-ink transition-colors hover:bg-aurea-surface-2 disabled:opacity-50"
              >
                {savingOutcome === o.value ? (
                  <Loader2 className="h-3 w-3 animate-spin" strokeWidth={1.75} />
                ) : (
                  o.value === 'appointment_booked' && <Check className="h-3 w-3 text-emerald-500" strokeWidth={2} />
                )}
                {o.label}
              </button>
            ))}
          </div>

          {/* Save notes/contact without choosing an outcome. */}
          <button
            onClick={saveAndClose}
            disabled={busy}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium text-aurea-ink-2 transition-colors hover:bg-aurea-surface-2 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-3 w-3 animate-spin" strokeWidth={1.75} />}
            Save &amp; close
          </button>
        </div>
      )}
    </div>
  )
}
