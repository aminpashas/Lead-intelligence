'use client'

/**
 * Softphone — the floating call widget, mounted once in the dashboard shell.
 *
 * It renders nothing while idle. During a call it shows the live controls (mute,
 * keypad, hang up, timer); when the call ends it prompts the staffer for an
 * outcome (disposition) and PATCHes it. All call state comes from useSoftphone().
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Phone, PhoneOff, Mic, MicOff, Grid3x3, X, Loader2, Check } from 'lucide-react'
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
  const { status, activeLead, muted, callSeconds, endedCall, hangup, toggleMute, sendDigit, clearEnded } =
    useSoftphone()
  const [showKeypad, setShowKeypad] = useState(false)
  const [savingOutcome, setSavingOutcome] = useState<string | null>(null)

  const inCall = status === 'connecting' || status === 'ringing' || status === 'in_call'

  // Nothing to show when idle and no call is awaiting disposition.
  if (!inCall && !endedCall) return null

  async function disposition(outcome: string) {
    if (!endedCall) return
    setSavingOutcome(outcome)
    try {
      const res = await fetch(`/api/voice/calls/${endedCall.callId}/disposition`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome }),
      })
      if (!res.ok) throw new Error('Failed to save')
      toast.success('Call logged')
      clearEnded()
      router.refresh()
    } catch {
      toast.error('Could not save outcome')
    } finally {
      setSavingOutcome(null)
    }
  }

  const leadName = activeLead
    ? `${activeLead.first_name}${activeLead.last_name ? ` ${activeLead.last_name}` : ''}`
    : endedCall
      ? `${endedCall.lead.first_name}${endedCall.lead.last_name ? ` ${endedCall.lead.last_name}` : ''}`
      : 'Lead'

  const statusLabel =
    status === 'connecting' ? 'Connecting…' : status === 'ringing' ? 'Ringing…' : status === 'in_call' ? fmt(callSeconds) : ''

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 overflow-hidden rounded-2xl border border-aurea-border bg-aurea-surface shadow-2xl">
      {/* ── Live call ─────────────────────────────────────────────── */}
      {inCall && (
        <div className="p-4">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-full',
                status === 'in_call' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-aurea-surface-2 text-aurea-ink-2'
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
        </div>
      )}

      {/* ── Disposition (call ended) ──────────────────────────────── */}
      {!inCall && endedCall && (
        <div className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-aurea-ink">Call ended</p>
              <p className="text-xs text-aurea-ink-3">
                {leadName} · {fmt(endedCall.durationSeconds)}
              </p>
            </div>
            <button
              onClick={clearEnded}
              title="Skip"
              className="flex h-7 w-7 items-center justify-center rounded-full text-aurea-ink-3 hover:bg-aurea-surface-2"
            >
              <X className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>

          <p className="mt-3 text-xs font-medium text-aurea-ink-2">How did it go?</p>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {OUTCOMES.map((o) => (
              <button
                key={o.value}
                onClick={() => disposition(o.value)}
                disabled={savingOutcome !== null}
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
        </div>
      )}
    </div>
  )
}
