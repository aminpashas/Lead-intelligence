'use client'

/**
 * SoftphoneProvider — owns the single Twilio Voice `Device` for the session and
 * drives the call state machine the floating widget renders.
 *
 * One Device is registered per browser tab (mic access, a Twilio websocket). It is
 * created lazily on first use so we don't request the mic on every page load, and
 * refreshed when its access token is about to expire.
 *
 * Placing a call is two hops: POST /api/voice/prepare (authenticated — runs the
 * compliance gate, returns a one-time dial token) then device.connect({dialToken}).
 * The widget only ever calls `startCall(lead)`; the rest is internal.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { Device as TwilioDevice, Call as TwilioCall } from '@twilio/voice-sdk'
import { toast } from 'sonner'
import type { Lead } from '@/types/database'

/**
 * The minimum a caller needs to hand us: an id (for /prepare) plus a name for the
 * widget. Full `Lead` (from lead-actions) and the slim rows from the power dialer
 * both satisfy this, so the softphone doesn't force either caller to over-fetch.
 */
export type DialableLead = Pick<Lead, 'id' | 'first_name' | 'last_name'>

/** Pretty-print a typed number for the widget: +14155551234 → (415) 555-1234. */
function formatDialedNumber(raw: string): string {
  const d = raw.replace(/\D/g, '')
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  if (ten.length === 10) return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`
  return raw
}

export type SoftphoneStatus =
  | 'offline' // Device not ready (not configured, or still registering)
  | 'idle' // Ready, no active call
  | 'connecting' // prepare + connect in flight
  | 'ringing' // lead's phone ringing
  | 'in_call' // connected
  | 'ended' // call over, awaiting disposition

type EndedCall = { callId: string; lead: DialableLead; durationSeconds: number }

type SoftphoneContextValue = {
  status: SoftphoneStatus
  ready: boolean
  activeLead: DialableLead | null
  muted: boolean
  callSeconds: number
  /** The just-ended call awaiting a disposition (null once dispositioned/cleared). */
  endedCall: EndedCall | null
  startCall: (lead: DialableLead) => Promise<void>
  /** Dial an arbitrary typed number (dial-any-number keypad). */
  startCallToNumber: (number: string) => Promise<void>
  hangup: () => void
  toggleMute: () => void
  sendDigit: (digit: string) => void
  clearEnded: () => void
}

const SoftphoneContext = createContext<SoftphoneContextValue | null>(null)

export function useSoftphone(): SoftphoneContextValue {
  const ctx = useContext(SoftphoneContext)
  if (!ctx) throw new Error('useSoftphone must be used within <SoftphoneProvider>')
  return ctx
}

export function SoftphoneProvider({ children }: { children: React.ReactNode }) {
  const deviceRef = useRef<TwilioDevice | null>(null)
  const callRef = useRef<TwilioCall | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const initStartedRef = useRef(false)

  const [status, setStatus] = useState<SoftphoneStatus>('offline')
  const [ready, setReady] = useState(false)
  const [activeLead, setActiveLead] = useState<DialableLead | null>(null)
  const [muted, setMuted] = useState(false)
  const [callSeconds, setCallSeconds] = useState(0)
  const [endedCall, setEndedCall] = useState<EndedCall | null>(null)

  // Keep the active call id (from prepare) around for disposition after hangup.
  const activeCallIdRef = useRef<string | null>(null)
  const activeLeadRef = useRef<DialableLead | null>(null)

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const resetCallState = useCallback(() => {
    stopTimer()
    callRef.current = null
    setActiveLead(null)
    activeLeadRef.current = null
    setMuted(false)
    setCallSeconds(0)
    setStatus(deviceRef.current ? 'idle' : 'offline')
  }, [stopTimer])

  /** Fetch a fresh browser access token. Returns null when the softphone is unconfigured. */
  const fetchToken = useCallback(async (): Promise<string | null> => {
    try {
      const res = await fetch('/api/voice/browser-token')
      if (!res.ok) return null
      const data = await res.json()
      return (data?.token as string) || null
    } catch {
      return null
    }
  }, [])

  /** Lazily create + register the Device. Safe to call repeatedly. */
  const ensureDevice = useCallback(async (): Promise<TwilioDevice | null> => {
    if (deviceRef.current) return deviceRef.current
    if (initStartedRef.current) return deviceRef.current
    initStartedRef.current = true

    const token = await fetchToken()
    if (!token) {
      initStartedRef.current = false
      return null
    }

    const { Device } = await import('@twilio/voice-sdk')
    const device = new Device(token, {
      // opus for quality, pcmu as the fallback carriers universally accept.
      codecPreferences: ['opus', 'pcmu'] as never,
      logLevel: 'error',
    })

    device.on('registered', () => {
      setReady(true)
      setStatus((s) => (s === 'offline' ? 'idle' : s))
    })
    device.on('error', (err: { message?: string }) => {
      // eslint-disable-next-line no-console
      console.error('[softphone] device error', err)
    })
    device.on('tokenWillExpire', async () => {
      const fresh = await fetchToken()
      if (fresh) device.updateToken(fresh)
    })

    deviceRef.current = device
    await device.register()
    return device
  }, [fetchToken])

  // Warm up the Device once on mount so the first click-to-call is instant.
  useEffect(() => {
    void ensureDevice()
    return () => {
      stopTimer()
      deviceRef.current?.destroy()
      deviceRef.current = null
    }
  }, [ensureDevice, stopTimer])

  const attachCallListeners = useCallback(
    (call: TwilioCall) => {
      call.on('ringing', () => setStatus('ringing'))
      call.on('accept', () => {
        setStatus('in_call')
        setCallSeconds(0)
        stopTimer()
        timerRef.current = setInterval(() => setCallSeconds((n) => n + 1), 1000)
      })
      const onEnd = () => {
        // Snapshot for the disposition prompt before we clear live state.
        const lead = activeLeadRef.current
        const callId = activeCallIdRef.current
        setCallSeconds((secs) => {
          if (lead && callId) setEndedCall({ callId, lead, durationSeconds: secs })
          return secs
        })
        resetCallState()
      }
      call.on('disconnect', onEnd)
      call.on('cancel', onEnd)
      call.on('reject', onEnd)
      call.on('error', (err: { message?: string }) => {
        // eslint-disable-next-line no-console
        console.error('[softphone] call error', err)
        toast.error('Call error')
        onEnd()
      })
    },
    [resetCallState, stopTimer]
  )

  // Shared dial path for both a known lead and a typed number. `display` is what the
  // widget shows; `prepareBody` is what /api/voice/prepare gates on (lead_id | to).
  const dial = useCallback(
    async (display: DialableLead, prepareBody: { lead_id: string } | { to: string }) => {
      if (status !== 'idle' && status !== 'offline') {
        toast.error('A call is already in progress')
        return
      }

      const device = await ensureDevice()
      if (!device) {
        toast.error('Dialer is not available (not configured)')
        return
      }

      setStatus('connecting')
      setActiveLead(display)
      activeLeadRef.current = display
      setEndedCall(null)

      // 1. Authenticated prepare — compliance gate + mint the one-time dial token.
      let dialToken: string
      try {
        const res = await fetch('/api/voice/prepare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(prepareBody),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.error || 'Could not place call')
        dialToken = data.dial_token
        activeCallIdRef.current = data.call_id
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not place call')
        resetCallState()
        return
      }

      // 2. Connect the browser leg; Twilio fetches TwiML with this token.
      try {
        const call = await device.connect({ params: { dialToken } })
        callRef.current = call
        attachCallListeners(call)
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[softphone] connect failed', e)
        toast.error('Could not connect the call')
        resetCallState()
      }
    },
    [status, ensureDevice, attachCallListeners, resetCallState]
  )

  const startCall = useCallback(
    (lead: DialableLead) => dial(lead, { lead_id: lead.id }),
    [dial]
  )

  const startCallToNumber = useCallback(
    (number: string) => {
      // Synthesize a display "lead" so the widget + disposition prompt render the
      // dialed number as the contact. The server never trusts this — it gates on `to`.
      const display: DialableLead = {
        id: `manual:${number}`,
        first_name: formatDialedNumber(number),
        last_name: null,
      }
      return dial(display, { to: number })
    },
    [dial]
  )

  const hangup = useCallback(() => {
    callRef.current?.disconnect()
    deviceRef.current?.disconnectAll()
  }, [])

  const toggleMute = useCallback(() => {
    const call = callRef.current
    if (!call) return
    const next = !muted
    call.mute(next)
    setMuted(next)
  }, [muted])

  const sendDigit = useCallback((digit: string) => {
    callRef.current?.sendDigits(digit)
  }, [])

  const clearEnded = useCallback(() => setEndedCall(null), [])

  return (
    <SoftphoneContext.Provider
      value={{
        status,
        ready,
        activeLead,
        muted,
        callSeconds,
        endedCall,
        startCall,
        startCallToNumber,
        hangup,
        toggleMute,
        sendDigit,
        clearEnded,
      }}
    >
      {children}
    </SoftphoneContext.Provider>
  )
}
