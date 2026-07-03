'use client'

/**
 * PowerDialer — walks a queue of callable leads through the browser softphone.
 *
 * It drives the shared softphone (useSoftphone): "Call" dials the current lead;
 * when that call wraps up (ends AND the corner widget's disposition is submitted),
 * the dialer advances. With Auto-advance on, it immediately places the next call;
 * off, it waits for the staffer to hit Call again. Disposition itself lives in the
 * global floating widget — one call-control surface, not two.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { PhoneOutgoing, SkipForward, Loader2, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSoftphone } from './softphone-provider'

export type DialerLead = {
  id: string
  first_name: string
  last_name: string | null
  ai_score: number | null
  ai_qualification: string
  status: string
  last_contacted_at: string | null
  city: string | null
  state: string | null
  phone_last4: string
}

const QUAL_COLOR: Record<string, string> = {
  hot: 'text-red-500 bg-red-500/10',
  warm: 'text-amber-500 bg-amber-500/10',
  cold: 'text-sky-500 bg-sky-500/10',
  unqualified: 'text-aurea-ink-3 bg-aurea-surface-2',
  unscored: 'text-aurea-ink-3 bg-aurea-surface-2',
}

function sinceLabel(iso: string | null): string {
  if (!iso) return 'never contacted'
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return 'contacted today'
  if (days === 1) return 'contacted yesterday'
  return `contacted ${days}d ago`
}

export function PowerDialer({ initialLeads }: { initialLeads: DialerLead[] }) {
  const { status, endedCall, startCall } = useSoftphone()
  const leads = initialLeads
  const [index, setIndex] = useState(0)
  const [handled, setHandled] = useState(0)
  const [autoAdvance, setAutoAdvance] = useState(false)

  // True only while a call WE placed is still outstanding (through disposition).
  const awaitingWrapRef = useRef(false)

  const current = leads[index]
  const onCall = status === 'connecting' || status === 'ringing' || status === 'in_call'
  const done = index >= leads.length

  const startCallAt = useCallback(
    (i: number) => {
      const lead = leads[i]
      if (!lead) return
      awaitingWrapRef.current = true
      void startCall(lead)
    },
    [leads, startCall]
  )

  // Advance when the call we placed has fully wrapped up (ended + dispositioned).
  useEffect(() => {
    if (awaitingWrapRef.current && status === 'idle' && !endedCall) {
      awaitingWrapRef.current = false
      setHandled((h) => h + 1)
      const next = index + 1
      setIndex(next)
      if (autoAdvance && next < leads.length) {
        // Small delay so the Device settles after disconnect before redialing.
        window.setTimeout(() => startCallAt(next), 600)
      }
    }
  }, [status, endedCall, index, autoAdvance, leads.length, startCallAt])

  function skip() {
    if (onCall) return
    setIndex((i) => i + 1)
  }

  const upNext = leads.slice(index + 1, index + 6)

  return (
    <div className="mx-auto max-w-2xl">
      {/* Header + progress */}
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold text-aurea-ink">Power Dialer</h1>
          <p className="text-sm text-aurea-ink-3">
            {handled} handled · {Math.max(leads.length - index, 0)} remaining of {leads.length}
          </p>
        </div>
        <button
          onClick={() => setAutoAdvance((v) => !v)}
          className={cn(
            'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
            autoAdvance
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
              : 'border-aurea-border text-aurea-ink hover:bg-aurea-surface-2'
          )}
        >
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              autoAdvance ? 'bg-emerald-500' : 'bg-aurea-ink-3'
            )}
          />
          Auto-advance {autoAdvance ? 'on' : 'off'}
        </button>
      </div>

      {leads.length > 0 && (
        <div className="mb-6 h-1.5 overflow-hidden rounded-full bg-aurea-surface-2">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${Math.min((index / leads.length) * 100, 100)}%` }}
          />
        </div>
      )}

      {/* Current lead / states */}
      {leads.length === 0 ? (
        <div className="rounded-2xl border border-aurea-border bg-aurea-surface p-10 text-center">
          <p className="text-sm text-aurea-ink-2">No callable leads right now.</p>
          <p className="mt-1 text-xs text-aurea-ink-3">
            The queue holds consented leads with a phone number that aren&apos;t on DND or the
            Do-Not-Call list.
          </p>
        </div>
      ) : done ? (
        <div className="rounded-2xl border border-aurea-border bg-aurea-surface p-10 text-center">
          <CheckCircle2 className="mx-auto mb-3 h-8 w-8 text-emerald-500" strokeWidth={1.5} />
          <p className="text-sm font-medium text-aurea-ink">Queue complete</p>
          <p className="mt-1 text-xs text-aurea-ink-3">You handled {handled} lead(s).</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-aurea-border bg-aurea-surface p-6">
          <div className="flex items-start justify-between">
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold text-aurea-ink">
                {current.first_name}
                {current.last_name ? ` ${current.last_name}` : ''}
              </p>
              <p className="mt-0.5 text-sm text-aurea-ink-3">
                •••• {current.phone_last4 || '—'}
                {current.city || current.state
                  ? ` · ${[current.city, current.state].filter(Boolean).join(', ')}`
                  : ''}
              </p>
              <p className="mt-0.5 text-xs text-aurea-ink-3">{sinceLabel(current.last_contacted_at)}</p>
            </div>
            <span
              className={cn(
                'rounded-full px-2.5 py-1 text-xs font-medium capitalize',
                QUAL_COLOR[current.ai_qualification] || QUAL_COLOR.unscored
              )}
            >
              {current.ai_qualification}
              {current.ai_score != null ? ` · ${current.ai_score}` : ''}
            </span>
          </div>

          <div className="mt-6 flex items-center gap-3">
            <button
              onClick={() => startCallAt(index)}
              disabled={onCall}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-500 py-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
            >
              {onCall ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} /> On call…
                </>
              ) : (
                <>
                  <PhoneOutgoing className="h-4 w-4" strokeWidth={2} /> Call
                </>
              )}
            </button>
            <button
              onClick={skip}
              disabled={onCall}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-aurea-border px-4 py-3 text-sm font-medium text-aurea-ink transition-colors hover:bg-aurea-surface-2 disabled:opacity-50"
            >
              <SkipForward className="h-4 w-4" strokeWidth={1.75} /> Skip
            </button>
          </div>
          <p className="mt-3 text-center text-xs text-aurea-ink-3">
            Log the outcome in the call widget when the call ends.
          </p>
        </div>
      )}

      {/* Up next */}
      {upNext.length > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-aurea-ink-3">Up next</p>
          <ul className="divide-y divide-aurea-border overflow-hidden rounded-xl border border-aurea-border bg-aurea-surface">
            {upNext.map((l) => (
              <li key={l.id} className="flex items-center justify-between px-4 py-2.5">
                <span className="truncate text-sm text-aurea-ink">
                  {l.first_name}
                  {l.last_name ? ` ${l.last_name}` : ''}
                </span>
                <span className="text-xs capitalize text-aurea-ink-3">
                  {l.ai_qualification}
                  {l.ai_score != null ? ` · ${l.ai_score}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
