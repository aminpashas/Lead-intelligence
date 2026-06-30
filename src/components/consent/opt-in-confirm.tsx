'use client'

import { useState } from 'react'

type State = 'idle' | 'loading' | 'done' | 'error'

export function OptInConfirm({
  token,
  orgName,
  channels,
}: {
  token: string
  orgName: string
  channels: string[]
}) {
  const [state, setState] = useState<State>('idle')
  const [message, setMessage] = useState('')

  const channelNoun: Record<string, string> = {
    sms: 'text messages',
    email: 'emails',
    voice: 'phone calls',
  }
  const channelLabels = channels.map((c) => channelNoun[c]).filter(Boolean)
  const channelLabel =
    channelLabels.length <= 1
      ? channelLabels[0] ?? 'messages'
      : channelLabels.length === 2
        ? `${channelLabels[0]} and ${channelLabels[1]}`
        : `${channelLabels.slice(0, -1).join(', ')}, and ${channelLabels[channelLabels.length - 1]}`

  async function confirm() {
    setState('loading')
    try {
      const res = await fetch('/api/consent/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (res.ok) {
        setState('done')
        return
      }
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      setState('error')
      setMessage(
        j.error === 'expired'
          ? 'This link has expired. Please ask us to send a new one.'
          : j.error === 'already_used'
            ? 'You have already confirmed — you are all set.'
            : 'Something went wrong. Please try again.'
      )
    } catch {
      setState('error')
      setMessage('Something went wrong. Please try again.')
    }
  }

  if (state === 'done') {
    return (
      <p style={{ fontSize: 15, color: '#15803d', fontWeight: 600 }}>
        ✓ Thank you! {orgName || 'Our team'} can now reach you with {channelLabel}.
      </p>
    )
  }

  return (
    <div>
      <button
        onClick={confirm}
        disabled={state === 'loading'}
        style={{
          background: '#dc2626',
          color: '#fff',
          padding: '12px 28px',
          borderRadius: 8,
          border: 'none',
          fontWeight: 700,
          fontSize: 15,
          cursor: state === 'loading' ? 'default' : 'pointer',
          opacity: state === 'loading' ? 0.7 : 1,
        }}
      >
        {state === 'loading' ? 'Confirming…' : `Yes, you can contact me`}
      </button>
      {state === 'error' && (
        <p style={{ fontSize: 13, color: '#b91c1c', marginTop: 12 }}>{message}</p>
      )}
    </div>
  )
}
