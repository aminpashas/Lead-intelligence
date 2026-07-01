'use client'

import { useState, useEffect } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Save, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'

type ProtocolSettings = {
  require_call_before_booking: boolean
  no_show_fee_enabled: boolean
  no_show_fee_cents: number
  youtube_testimonial_url: string | null
  consult_price_range_text: string | null
  discovery_script: string | null
  feedback_request_enabled: boolean
  google_review_url: string | null
  feedback_promoter_threshold: number
  feedback_delay_hours: number
}

const DEFAULTS: ProtocolSettings = {
  require_call_before_booking: false,
  no_show_fee_enabled: false,
  no_show_fee_cents: 5000,
  youtube_testimonial_url: null,
  consult_price_range_text: null,
  discovery_script: null,
  feedback_request_enabled: false,
  google_review_url: null,
  feedback_promoter_threshold: 4,
  feedback_delay_hours: 2,
}

export function BookingProtocolSettings() {
  const [settings, setSettings] = useState<ProtocolSettings>(DEFAULTS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/settings/booking-protocol')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setSettings({ ...DEFAULTS, ...d.settings }))
      .catch(() => setError('Failed to load booking protocol settings'))
      .finally(() => setLoading(false))
  }, [])

  function update<K extends keyof ProtocolSettings>(key: K, value: ProtocolSettings[K]) {
    setSettings((s) => ({ ...s, [key]: value }))
    setSaved(false)
  }

  async function save() {
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/settings/booking-protocol', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          require_call_before_booking: settings.require_call_before_booking,
          no_show_fee_enabled: settings.no_show_fee_enabled,
          no_show_fee_cents: settings.no_show_fee_cents,
          youtube_testimonial_url: settings.youtube_testimonial_url || '',
          consult_price_range_text: settings.consult_price_range_text || '',
          discovery_script: settings.discovery_script || '',
          feedback_request_enabled: settings.feedback_request_enabled,
          google_review_url: settings.google_review_url || '',
          feedback_promoter_threshold: settings.feedback_promoter_threshold,
          feedback_delay_hours: settings.feedback_delay_hours,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Save failed')
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-5 py-6 text-aurea-ink-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    )
  }

  const feeDollars = Math.round(settings.no_show_fee_cents / 100)

  return (
    <div className="px-5 py-5 space-y-6">
      {/* Phone-first gate */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label className="text-[14px] text-aurea-ink">Require a phone call before booking</Label>
          <p className="text-[13px] leading-relaxed text-aurea-ink-2">
            The AI won&apos;t book consultations over text, and staff must log a qualifying call
            (or record an override reason). The public booking page captures a call request instead of confirming.
          </p>
        </div>
        <Switch
          checked={settings.require_call_before_booking}
          onCheckedChange={(v) => update('require_call_before_booking', v)}
        />
      </div>

      {/* No-show fee */}
      <div className="flex items-start justify-between gap-4 border-t border-aurea-border pt-6">
        <div className="space-y-1">
          <Label className="text-[14px] text-aurea-ink">Collect a card to reserve (no-show fee)</Label>
          <p className="text-[13px] leading-relaxed text-aurea-ink-2">
            After booking, the patient gets a link to save a card. The consult is free; the card is charged
            automatically only if they&apos;re marked a no-show.
          </p>
        </div>
        <Switch
          checked={settings.no_show_fee_enabled}
          onCheckedChange={(v) => update('no_show_fee_enabled', v)}
        />
      </div>

      {settings.no_show_fee_enabled && (
        <div className="space-y-2 pl-1">
          <Label className="aurea-eyebrow">No-show fee amount (USD)</Label>
          <div className="flex items-center gap-2">
            <span className="text-aurea-ink-2">$</span>
            <Input
              type="number"
              min={0}
              max={1000}
              value={feeDollars}
              onChange={(e) => update('no_show_fee_cents', Math.max(0, Math.round(Number(e.target.value) || 0)) * 100)}
              className="w-28"
            />
          </div>
        </div>
      )}

      {/* Discovery assets */}
      <div className="space-y-2 border-t border-aurea-border pt-6">
        <Label className="aurea-eyebrow">Doctor testimonial video URL (YouTube)</Label>
        <Input
          type="url"
          placeholder="https://youtube.com/…"
          value={settings.youtube_testimonial_url || ''}
          onChange={(e) => update('youtube_testimonial_url', e.target.value)}
        />
        <p className="text-[12px] text-aurea-ink-2">Sent to patients when the AI or a rep shares testimonials.</p>
      </div>

      <div className="space-y-2">
        <Label className="aurea-eyebrow">Consultation price-range talking point</Label>
        <Input
          placeholder="e.g. Full-arch treatment typically ranges from $20k–$30k per arch"
          value={settings.consult_price_range_text || ''}
          onChange={(e) => update('consult_price_range_text', e.target.value)}
        />
        <p className="text-[12px] text-aurea-ink-2">Sets budget expectations on the discovery call (a range, not a quote).</p>
      </div>

      <div className="space-y-2">
        <Label className="aurea-eyebrow">Discovery call script (optional)</Label>
        <Textarea
          rows={6}
          placeholder="Leave blank to use the default discovery script (open-ended pain-point questions, full-arch framing, testimonials, budget range)."
          value={settings.discovery_script || ''}
          onChange={(e) => update('discovery_script', e.target.value)}
        />
      </div>

      {/* Patient feedback */}
      <div className="space-y-4 border-t border-aurea-border pt-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label className="text-[14px] text-aurea-ink">Request feedback after consults</Label>
            <p className="text-[13px] leading-relaxed text-aurea-ink-2">
              Text/email attendees a quick rating; happy patients are invited to leave a public review.
            </p>
          </div>
          <Switch
            checked={settings.feedback_request_enabled}
            onCheckedChange={(v) => update('feedback_request_enabled', v)}
          />
        </div>

        {settings.feedback_request_enabled && (
          <>
            <div className="space-y-2 pl-1">
              <Label className="aurea-eyebrow">Google review link</Label>
              <Input
                type="url"
                placeholder="https://g.page/r/…/review"
                value={settings.google_review_url || ''}
                onChange={(e) => update('google_review_url', e.target.value)}
              />
              <p className="text-[12px] text-aurea-ink-2">Required — no feedback is sent until this is set.</p>
            </div>

            <div className="grid grid-cols-2 gap-4 pl-1">
              <div className="space-y-2">
                <Label className="aurea-eyebrow">Send feedback after (hours)</Label>
                <Input
                  type="number"
                  min={0}
                  max={168}
                  value={settings.feedback_delay_hours}
                  onChange={(e) => update('feedback_delay_hours', Math.max(0, Math.min(168, Math.round(Number(e.target.value) || 0))))}
                />
              </div>
              <div className="space-y-2">
                <Label className="aurea-eyebrow">Route to review at (stars)</Label>
                <Input
                  type="number"
                  min={1}
                  max={5}
                  value={settings.feedback_promoter_threshold}
                  onChange={(e) => update('feedback_promoter_threshold', Math.max(1, Math.min(5, Math.round(Number(e.target.value) || 4))))}
                />
              </div>
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-aurea-border pt-5">
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          <span className="ml-2">Save</span>
        </Button>
        {saved && (
          <span className="flex items-center gap-1.5 text-[13px] text-aurea-primary">
            <CheckCircle2 className="h-4 w-4" /> Saved
          </span>
        )}
        {error && (
          <span className="flex items-center gap-1.5 text-[13px] text-red-500">
            <AlertCircle className="h-4 w-4" /> {error}
          </span>
        )}
      </div>
    </div>
  )
}
