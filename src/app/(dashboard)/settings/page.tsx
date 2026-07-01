'use client'

import { useOrgStore } from '@/lib/store/use-org'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Copy, Check } from 'lucide-react'
import { useState } from 'react'
import { BookingProtocolSettings } from '@/components/settings/booking-protocol-settings'

export default function SettingsPage() {
  const { organization } = useOrgStore()
  const [copied, setCopied] = useState<string | null>(null)

  const webhookUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/api/webhooks/form?org=${organization?.id}`
    : ''

  function copyToClipboard(text: string, key: string) {
    navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }

  // Subscription tier badge color
  const tier = organization?.subscription_tier || 'trial'
  const tierClass = tier === 'trial'
    ? 'bg-aurea-amber/10 text-aurea-amber border-aurea-amber/20'
    : 'bg-aurea-primary/10 text-aurea-primary border-aurea-primary/20'

  return (
    <div className="animate-in fade-in-0 duration-500 max-w-2xl space-y-8">
      {/* ── Header ──────────────────────────────────────────── */}
      <header className="border-b border-aurea-border pb-8">
        <p className="aurea-eyebrow mb-3">Account</p>
        <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[48px]">Settings</h1>
        <p className="mt-4 text-[15px] leading-relaxed text-aurea-ink-2">
          Manage your practice settings and integrations.
        </p>
      </header>

      {/* ── Practice information ─────────────────────────────── */}
      <section className="aurea-card overflow-hidden">
        <div className="border-b border-aurea-border px-5 py-4">
          <h2 className="aurea-display text-[22px] text-aurea-ink">Practice Information</h2>
        </div>
        <div className="px-5 py-5 space-y-5">
          <div className="space-y-2">
            <Label className="aurea-eyebrow">Practice Name</Label>
            <Input value={organization?.name || ''} readOnly />
          </div>
          <div className="space-y-2">
            <Label className="aurea-eyebrow">Subscription</Label>
            <div>
              <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold capitalize ${tierClass}`}>
                {tier}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ── Webhook integration ──────────────────────────────── */}
      <section className="aurea-card overflow-hidden">
        <div className="border-b border-aurea-border px-5 py-4">
          <h2 className="aurea-display text-[22px] text-aurea-ink">Webhook Integration</h2>
          <p className="mt-0.5 text-[12px] text-aurea-ink-3">
            Use these URLs to connect your landing pages, Google Ads, and Meta Lead Ads
          </p>
        </div>
        <div className="px-5 py-5 space-y-5">
          {/* Universal form webhook */}
          <div className="space-y-2">
            <Label className="aurea-eyebrow">Universal Form Webhook</Label>
            <div className="flex gap-2">
              <Input value={webhookUrl} readOnly className="font-mono text-xs" />
              <Button
                variant="outline"
                size="icon"
                onClick={() => copyToClipboard(webhookUrl, 'form')}
              >
                {copied === 'form' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-[12px] text-aurea-ink-3">
              POST JSON with: first_name, last_name, email, phone, source_type, utm_source, dental_condition
            </p>
          </div>

          <div className="h-px bg-aurea-border" />

          {/* Twilio webhook */}
          <div className="space-y-2">
            <Label className="aurea-eyebrow">Twilio SMS Webhook</Label>
            <div className="flex gap-2">
              <Input
                value={typeof window !== 'undefined' ? `${window.location.origin}/api/webhooks/twilio` : ''}
                readOnly
                className="font-mono text-xs"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => copyToClipboard(
                  typeof window !== 'undefined' ? `${window.location.origin}/api/webhooks/twilio` : '',
                  'twilio'
                )}
              >
                {copied === 'twilio' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-[12px] text-aurea-ink-3">
              Set this as your Twilio phone number&apos;s SMS webhook URL
            </p>
          </div>

          <div className="h-px bg-aurea-border" />

          {/* Resend webhook */}
          <div className="space-y-2">
            <Label className="aurea-eyebrow">Resend Email Webhook</Label>
            <div className="flex gap-2">
              <Input
                value={typeof window !== 'undefined' ? `${window.location.origin}/api/webhooks/resend` : ''}
                readOnly
                className="font-mono text-xs"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => copyToClipboard(
                  typeof window !== 'undefined' ? `${window.location.origin}/api/webhooks/resend` : '',
                  'resend'
                )}
              >
                {copied === 'resend' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-[12px] text-aurea-ink-3">
              Set this in Resend dashboard &gt; Webhooks. Tracks email opens, clicks, bounces, and complaints.
            </p>
          </div>
        </div>
      </section>

      {/* Marketing Connectors, Team, Billing, AI Control, Legal and Contract
          Templates are now tabs of the Settings hub (see settings/layout.tsx),
          so they no longer need link cards here. */}

      {/* ── Online booking ───────────────────────────────────── */}
      <section className="aurea-card overflow-hidden">
        <div className="border-b border-aurea-border px-5 py-4">
          <h2 className="aurea-display text-[22px] text-aurea-ink">Online Booking</h2>
          <p className="mt-0.5 text-[12px] text-aurea-ink-3">
            Share this link with leads so they can self-book consultations
          </p>
        </div>
        <div className="px-5 py-5 space-y-5">
          <div className="space-y-2">
            <Label className="aurea-eyebrow">Public Booking Page</Label>
            <div className="flex gap-2">
              <Input
                value={typeof window !== 'undefined' ? `${window.location.origin}/book/${organization?.id}` : ''}
                readOnly
                className="font-mono text-xs"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => copyToClipboard(
                  typeof window !== 'undefined' ? `${window.location.origin}/book/${organization?.id}` : '',
                  'booking'
                )}
              >
                {copied === 'booking' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-[12px] text-aurea-ink-3">
              Leads can book directly from this page. Use{' '}
              <code className="bg-aurea-surface-2 px-1 rounded text-aurea-ink font-mono">{'{{booking_link}}'}</code>{' '}
              in campaign templates.
            </p>
          </div>
          <div className="h-px bg-aurea-border" />
          <p className="text-[12px] text-aurea-ink-3">
            To configure availability (office hours, slot duration, blocked dates), update the{' '}
            <code className="bg-aurea-surface-2 px-1 rounded text-aurea-ink font-mono">booking_settings</code>{' '}
            table in your Supabase dashboard. Default: Mon–Fri 9am–5pm, 60-minute slots, 15-minute buffer.
          </p>
        </div>
      </section>

      {/* ── Booking protocol (phone-first + no-show fee) ─────── */}
      <section className="aurea-card overflow-hidden">
        <div className="border-b border-aurea-border px-5 py-4">
          <h2 className="aurea-display text-[22px] text-aurea-ink">Booking Protocol</h2>
          <p className="mt-0.5 text-[12px] text-aurea-ink-3">
            Phone-first booking and no-show fee — designed to reduce no-shows on full-arch consultations
          </p>
        </div>
        <BookingProtocolSettings />
      </section>
    </div>
  )
}
