'use client'

/**
 * ManualDialPad — dial an arbitrary typed number through the browser softphone.
 *
 * Sits alongside the power-dialer queue so staff aren't limited to the lead list.
 * It only collects a number and calls startCallToNumber(); the server (/api/voice/
 * prepare) runs the reduced manual gate (E.164, DNC-by-number, org enabled, rate
 * limit), and the floating widget owns the live call + disposition as usual.
 */

import { useState } from 'react'
import { PhoneOutgoing, Delete, Loader2, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSoftphone } from './softphone-provider'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']

/** Pretty-print as the user types: 4155551234 → (415) 555-1234. */
function formatInput(digits: string): string {
  const d = digits.replace(/\D/g, '').slice(0, 11)
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  if (ten.length <= 3) return ten
  if (ten.length <= 6) return `(${ten.slice(0, 3)}) ${ten.slice(3)}`
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6, 10)}`
}

export function ManualDialPad() {
  const { status, startCallToNumber } = useSoftphone()
  const [value, setValue] = useState('')
  const [open, setOpen] = useState(false)

  const onCall = status === 'connecting' || status === 'ringing' || status === 'in_call'
  const digits = value.replace(/\D/g, '')
  const canCall = digits.length >= 10 && !onCall

  function press(k: string) {
    // Keep only what E.164 cares about: digits (plus * / # for vanity input).
    setValue((v) => (v + k).replace(/[^\d*#]/g, '').slice(0, 15))
  }

  function call() {
    if (!canCall) return
    void startCallToNumber(digits)
  }

  return (
    <div className="mb-6 overflow-hidden rounded-2xl border border-aurea-border bg-aurea-surface">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-6 py-4 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-aurea-ink">
          <PhoneOutgoing className="h-4 w-4 text-aurea-ink-3" strokeWidth={1.75} />
          Dial a number
        </span>
        <ChevronDown
          className={cn('h-4 w-4 text-aurea-ink-3 transition-transform', open && 'rotate-180')}
          strokeWidth={1.75}
        />
      </button>

      {open && (
        <div className="border-t border-aurea-border p-6">
          <div className="mb-4 flex items-center gap-2">
            <input
              value={formatInput(value)}
              onChange={(e) => setValue(e.target.value.replace(/[^\d*#]/g, '').slice(0, 15))}
              onKeyDown={(e) => e.key === 'Enter' && call()}
              inputMode="tel"
              placeholder="(555) 123-4567"
              className="min-w-0 flex-1 rounded-xl border border-aurea-border bg-aurea-surface-2 px-4 py-3 text-center text-lg tabular-nums text-aurea-ink outline-none placeholder:text-aurea-ink-3 focus:border-emerald-500/40"
            />
            <button
              onClick={() => setValue((v) => v.slice(0, -1))}
              disabled={!value || onCall}
              title="Delete"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-aurea-border text-aurea-ink-2 transition-colors hover:bg-aurea-surface-2 disabled:opacity-40"
            >
              <Delete className="h-5 w-5" strokeWidth={1.75} />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {KEYS.map((k) => (
              <button
                key={k}
                onClick={() => press(k)}
                disabled={onCall}
                className="rounded-xl border border-aurea-border py-3 text-lg font-medium text-aurea-ink transition-colors hover:bg-aurea-surface-2 disabled:opacity-40"
              >
                {k}
              </button>
            ))}
          </div>

          <button
            onClick={call}
            disabled={!canCall}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 py-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
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
        </div>
      )}
    </div>
  )
}
