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

type EndedCall = {
  callId: string
  lead: DialableLead
  durationSeconds: number
  /** True when the call was picked up (reached `in_call`) — drives the auto-summary. */
  answered: boolean
  /** True for a manual dial to a number that matched no lead — offer a contact form. */
  needsContact: boolean
  /** The dialed E.164/number, used to label + (server-side) hash-match the new lead. */
  toNumber: string | null
}

type SoftphoneContextValue = {
  status: SoftphoneStatus
  ready: boolean
  activeLead: DialableLead | null
  muted: boolean
  held: boolean
  callSeconds: number
  /** The just-ended call awaiting a disposition (null once dispositioned/cleared). */
  endedCall: EndedCall | null
  /** Live-call flag: a manual dial to an unknown number → offer a contact form. */
  needsContact: boolean
  startCall: (lead: DialableLead) => Promise<void>
  /** Dial an arbitrary typed number (dial-any-number keypad). */
  startCallToNumber: (number: string) => Promise<void>
  hangup: () => void
  toggleMute: () => void
  toggleHold: () => void
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
  const [held, setHeld] = useState(false)
  const [callSeconds, setCallSeconds] = useState(0)
  const [endedCall, setEndedCall] = useState<EndedCall | null>(null)
  const [needsContact, setNeedsContact] = useState(false)

  // Keep the active call id (from prepare) around for disposition after hangup.
  const activeCallIdRef = useRef<string | null>(null)
  const activeLeadRef = useRef<DialableLead | null>(null)
  // Was the current call picked up? Set on `accept`, read on end for the auto-summary.
  const answeredRef = useRef(false)
  // Manual dial to a number with no matching lead → the widget offers a contact form.
  const needsContactRef = useRef(false)
  const activeToNumberRef = useRef<string | null>(null)
  // Mirror of callSeconds so `onEnd` can read the final duration without reaching
  // into a state updater (which can double-run in dev StrictMode).
  const callSecondsRef = useRef(0)

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
    answeredRef.current = false
    setMuted(false)
    setHeld(false)
    callSecondsRef.current = 0
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

  // Fire-and-forget: write a factual call-history summary the instant an answered
  // call ends. Carries no outcome — the staffer's disposition (if any) enriches the
  // same voice_calls row afterwards. Failures are non-fatal (best-effort logging).
  const autoLogSummary = useCallback(async (callId: string, durationSeconds: number) => {
    try {
      await fetch(`/api/voice/calls/${callId}/disposition`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration_seconds: durationSeconds }),
      })
    } catch {
      /* best-effort */
    }
  }, [])

  const attachCallListeners = useCallback(
    (call: TwilioCall) => {
      call.on('ringing', () => setStatus('ringing'))
      call.on('accept', () => {
        setStatus('in_call')
        answeredRef.current = true
        callSecondsRef.current = 0
        setCallSeconds(0)
        stopTimer()
        timerRef.current = setInterval(() => {
          callSecondsRef.current += 1
          setCallSeconds(callSecondsRef.current)
        }, 1000)
      })
      const onEnd = () => {
        // Snapshot for the disposition prompt before we clear live state.
        const lead = activeLeadRef.current
        const callId = activeCallIdRef.current
        const answered = answeredRef.current
        const secs = callSecondsRef.current
        if (lead && callId) {
          setEndedCall({
            callId,
            lead,
            durationSeconds: secs,
            answered,
            needsContact: needsContactRef.current,
            toNumber: activeToNumberRef.current,
          })
          // Answered calls (and voicemails, which also connect) are logged to call
          // history right away, so nothing is lost if the staffer closes the widget
          // before dispositioning. A later disposition enriches this same row.
          if (answered) void autoLogSummary(callId, secs)
        }
        resetCallState()
      }
      call.on('disconnect', onEnd)
      call.on('cancel', onEnd)
      call.on('reject', onEnd)
      call.on('error', (err: { message?: string }) => {
         
        console.error('[softphone] call error', err)
        toast.error('Call error')
        onEnd()
      })
    },
    [resetCallState, stopTimer, autoLogSummary]
  )

  // Shared dial path for both a known lead and a typed number. `display` is what the
  // widget shows; `prepareBody` is what /api/voice/prepare gates on (lead_id | to).
  const dial = useCallback(
    async (
      display: DialableLead,
      prepareBody: { lead_id: string } | { to: string },
      opts?: { isManual?: boolean }
    ) => {
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
      answeredRef.current = false
      needsContactRef.current = false
      setNeedsContact(false)
      activeToNumberRef.current = 'to' in prepareBody ? prepareBody.to : null
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
        // A manual dial to a number that matched no existing lead is the one case
        // where we invite the staffer to capture the contact as they talk.
        needsContactRef.current = !!opts?.isManual && data.matched_lead === false
        setNeedsContact(needsContactRef.current)
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
      return dial(display, { to: number }, { isManual: true })
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
    // Effective mic state is muted OR held; toggling mute must not un-mute a held call.
    call.mute(next || held)
    setMuted(next)
  }, [muted, held])

  // Hold: put the lead on real hold music via the conference (server-side), so the
  // lead hears music — not dead air — while the agent steps away. We ALSO apply the
  // local mute/remote-disable immediately so there's no audible gap before Twilio
  // applies the participant hold (~a few hundred ms). If the server call fails we
  // roll both back to the pre-toggle state.
  const applyLocalHold = useCallback((call: TwilioCall, holdState: boolean, isMuted: boolean) => {
    call.mute(holdState || isMuted)
    call.getRemoteStream()?.getAudioTracks().forEach((track) => {
      track.enabled = !holdState
    })
  }, [])

  const toggleHold = useCallback(async () => {
    const call = callRef.current
    const callId = activeCallIdRef.current
    if (!call || !callId || status !== 'in_call') return

    const next = !held
    setHeld(next)
    applyLocalHold(call, next, muted)

    try {
      const res = await fetch('/api/voice/hold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ call_id: callId, hold: next }),
      })
      if (!res.ok) throw new Error('hold failed')
    } catch {
      setHeld(!next)
      applyLocalHold(call, !next, muted)
      toast.error(next ? 'Could not place the call on hold' : 'Could not resume the call')
    }
  }, [held, muted, status, applyLocalHold])

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
        held,
        callSeconds,
        endedCall,
        needsContact,
        startCall,
        startCallToNumber,
        hangup,
        toggleMute,
        toggleHold,
        sendDigit,
        clearEnded,
      }}
    >
      {children}
    </SoftphoneContext.Provider>
  )
}
