'use client'

/**
 * Settings → Notifications card (Workstream D5).
 *
 * Two concerns:
 *   1. Web Push enrollment for THIS browser — fetch the VAPID key, ask for
 *      Notification permission, register /sw.js, subscribe, and store the
 *      subscription via /api/push/subscribe (disable = the reverse).
 *   2. Per-user channel toggles (Slack / SMS / Email / Push) written to
 *      user_profiles.notification_prefs via /api/profile/notification-prefs.
 *      Default-on posture: a missing key means the channel is enabled.
 *
 * Note: Slack delivery is org-level (the Slack connector must subscribe to
 * 'message.received' under Settings → Connectors); the per-user Slack toggle
 * is stored alongside the others for forward compatibility.
 */

import { useCallback, useEffect, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Bell, BellOff, Loader2 } from 'lucide-react'

type Channel = 'slack' | 'sms' | 'email' | 'push'
type Prefs = Partial<Record<Channel, boolean>>

const CHANNEL_LABELS: Array<{ key: Channel; label: string; hint: string }> = [
  { key: 'push', label: 'Browser push', hint: 'Desktop/mobile notifications from this app' },
  { key: 'sms', label: 'SMS', hint: 'Text message to your staff phone number' },
  { key: 'email', label: 'Email', hint: 'Escalation alerts to your inbox' },
  { key: 'slack', label: 'Slack', hint: 'Team channel posts (requires the org Slack connector)' },
]

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(b64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

export function NotificationSettings() {
  const [prefs, setPrefs] = useState<Prefs>({})
  const [loading, setLoading] = useState(true)
  const [pushSupported, setPushSupported] = useState(true)
  const [pushSubscribed, setPushSubscribed] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const [error, setError] = useState('')

  // Load stored prefs + this browser's current subscription state.
  useEffect(() => {
    fetch('/api/profile/notification-prefs')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setPrefs(d.prefs ?? {}))
      .catch(() => setError('Failed to load notification preferences'))
      .finally(() => setLoading(false))

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushSupported(false)
      return
    }
    navigator.serviceWorker
      .getRegistration('/sw.js')
      .then((reg) => reg?.pushManager.getSubscription())
      .then((sub) => setPushSubscribed(!!sub))
      .catch(() => setPushSubscribed(false))
  }, [])

  const updatePref = useCallback((channel: Channel, value: boolean) => {
    setError('')
    setPrefs((p) => ({ ...p, [channel]: value })) // optimistic
    fetch('/api/profile/notification-prefs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [channel]: value }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setPrefs(d.prefs ?? {}))
      .catch(() => {
        setPrefs((p) => ({ ...p, [channel]: !value })) // roll back
        setError('Failed to save preference — try again')
      })
  }, [])

  async function enablePush() {
    setPushBusy(true)
    setError('')
    try {
      const keyRes = await fetch('/api/push/vapid-public-key')
      if (!keyRes.ok) {
        const d = await keyRes.json().catch(() => null)
        throw new Error(d?.error || 'Push notifications are not configured on this server')
      }
      const { publicKey } = await keyRes.json()

      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        throw new Error('Notification permission was not granted')
      }

      const registration = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      })

      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      })
      if (!res.ok) throw new Error('Failed to store push subscription')

      setPushSubscribed(true)
      if (prefs.push === false) updatePref('push', true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enable push notifications')
    } finally {
      setPushBusy(false)
    }
  }

  async function disablePush() {
    setPushBusy(true)
    setError('')
    try {
      const registration = await navigator.serviceWorker.getRegistration('/sw.js')
      const subscription = await registration?.pushManager.getSubscription()
      if (subscription) {
        const endpoint = subscription.endpoint
        await subscription.unsubscribe()
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint }),
        })
      }
      setPushSubscribed(false)
    } catch {
      setError('Failed to disable push notifications')
    } finally {
      setPushBusy(false)
    }
  }

  return (
    <section className="aurea-card overflow-hidden">
      <div className="border-b border-aurea-border px-5 py-4">
        <h2 className="aurea-display text-[22px] text-aurea-ink">Notifications</h2>
        <p className="mt-0.5 text-[12px] text-aurea-ink-3">
          How you&apos;re alerted when a patient message or AI escalation needs a human
        </p>
      </div>
      <div className="px-5 py-5 space-y-6">
        {/* ── Browser push enrollment ────────────────────────── */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[14px] font-medium text-aurea-ink">Push on this device</p>
            <p className="text-[12px] text-aurea-ink-3">
              {pushSupported
                ? pushSubscribed
                  ? 'This browser receives push notifications'
                  : 'Enable to get notifications on this browser'
                : 'This browser does not support push notifications'}
            </p>
          </div>
          <Button
            variant={pushSubscribed ? 'outline' : 'default'}
            size="sm"
            disabled={!pushSupported || pushBusy}
            onClick={pushSubscribed ? disablePush : enablePush}
          >
            {pushBusy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : pushSubscribed ? (
              <BellOff className="size-4" />
            ) : (
              <Bell className="size-4" />
            )}
            {pushSubscribed ? 'Disable push' : 'Enable push'}
          </Button>
        </div>

        {/* ── Per-channel toggles ────────────────────────────── */}
        <div className="space-y-4">
          {CHANNEL_LABELS.map(({ key, label, hint }) => (
            <div key={key} className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[14px] font-medium text-aurea-ink">{label}</p>
                <p className="text-[12px] text-aurea-ink-3">{hint}</p>
              </div>
              <Switch
                checked={prefs[key] !== false}
                disabled={loading}
                onCheckedChange={(v) => updatePref(key, v)}
              />
            </div>
          ))}
        </div>

        {error && <p className="text-[12px] text-red-600">{error}</p>}
      </div>
    </section>
  )
}
