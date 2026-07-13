'use client'

/**
 * Settings → Your Profile card.
 *
 * Self-serve editing of the fields an agent owns about themselves. Today that's
 * their mobile number, which powers "Call my phone" (the ring-my-phone bridge
 * dial). Reads/writes /api/profile — writing is allowed on the caller's own row
 * via the user_profiles self-update RLS policy.
 */

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Loader2, Check } from 'lucide-react'

export function ProfileSettings() {
  const [phone, setPhone] = useState('')
  const [initial, setInitial] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/profile')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        const value = d.phone ?? ''
        setPhone(value)
        setInitial(value)
      })
      .catch(() => setError('Failed to load your profile'))
      .finally(() => setLoading(false))
  }, [])

  const dirty = phone.trim() !== initial

  async function save() {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'Could not save your number')
      const value = data.phone ?? ''
      setPhone(value)
      setInitial(value)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your number')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="aurea-card overflow-hidden">
      <div className="border-b border-aurea-border px-5 py-4">
        <h2 className="aurea-display text-[22px] text-aurea-ink">Your Profile</h2>
        <p className="mt-0.5 text-[12px] text-aurea-ink-3">
          Personal settings for your own account
        </p>
      </div>
      <div className="px-5 py-5 space-y-2">
        <Label htmlFor="profile-phone" className="aurea-eyebrow">
          Your mobile number
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id="profile-phone"
            type="tel"
            inputMode="tel"
            placeholder="+14155551234"
            value={phone}
            disabled={loading || saving}
            onChange={(e) => {
              setPhone(e.target.value)
              setSaved(false)
            }}
            className="font-mono"
          />
          <Button size="sm" onClick={save} disabled={loading || saving || !dirty}>
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : saved ? (
              <Check className="size-4" />
            ) : null}
            {saved ? 'Saved' : 'Save'}
          </Button>
        </div>
        <p className="text-[12px] text-aurea-ink-3">
          Used for &ldquo;Call my phone&rdquo; — when you place a call, we ring this number
          first, then connect the patient. Leave blank to disable it.
        </p>
        {error && <p className="text-[12px] text-red-600">{error}</p>}
      </div>
    </section>
  )
}
