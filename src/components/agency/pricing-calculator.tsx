'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Loader2, Check } from 'lucide-react'
import { toast } from 'sonner'

export type PricingPractice = {
  id: string
  name: string
  /** Provider cost of usage over the trailing 30 days (≈ monthly), in cents. */
  usageCostCents: number
  /** Current resolved re-bill markup percent (200 = 3×). */
  currentMarkupPct: number
  /** Current resolved monthly platform fee, in cents. */
  currentFeeCents: number
  /** Whether this practice has an explicit billing_settings row (vs. running on defaults). */
  hasOverride: boolean
  /** Whether monthly auto-charge is enabled for this practice. */
  autocharge: boolean
  /** Whether a Stripe card is on file (autocharge / reload can only fire when true). */
  hasCardOnFile: boolean
  /** Prepaid wallet mode (usage draws down a balance instead of monthly invoicing). */
  prepaid: boolean
  /** Prepaid auto-reload when the balance runs low. */
  autoReload: boolean
  /** Reload top-up amount, in cents. */
  reloadAmountCents: number
  /** Current prepaid balance, in cents. */
  balanceCents: number
}

const usd = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

function initials(name: string) {
  return name.split(' ').map((w) => w[0]).filter(Boolean).join('').toUpperCase().slice(0, 2)
}

export function PricingCalculator({ practices }: { practices: PricingPractice[] }) {
  return (
    <div className="mt-8 space-y-3">
      {/* Column legend (sm+) */}
      <div className="hidden items-center gap-4 px-5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-aurea-ink-3 sm:flex">
        <span className="flex-1">Practice</span>
        <span className="w-24 text-right">Markup ×</span>
        <span className="w-28 text-right">Fee / mo</span>
        <span className="w-28 text-right">Blended / mo</span>
        <span className="w-20" />
      </div>
      {practices.map((p) => (
        <PracticeRow key={p.id} practice={p} />
      ))}
      <p className="px-1 pt-2 text-[11.5px] leading-relaxed text-aurea-ink-3">
        Markup is the multiple of provider cost billed to the practice (3× = 200% markup). Blended
        monthly = usage re-bill (last 30 days of usage × markup) + the flat platform fee. Practices
        with no explicit pricing run on the house default until you save one.
      </p>
    </div>
  )
}

function PracticeRow({ practice }: { practice: PricingPractice }) {
  const [multiple, setMultiple] = useState(1 + practice.currentMarkupPct / 100)
  const [feeDollars, setFeeDollars] = useState(Math.round(practice.currentFeeCents / 100))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [issuing, setIssuing] = useState(false)
  const [autocharge, setAutocharge] = useState(practice.autocharge)
  const [settingUpCard, setSettingUpCard] = useState(false)
  const [prepaid, setPrepaid] = useState(practice.prepaid)
  const [autoReload, setAutoReload] = useState(practice.autoReload)
  const [reloadDollars, setReloadDollars] = useState(Math.round(practice.reloadAmountCents / 100))
  const [reloading, setReloading] = useState(false)

  const markupPct = Math.max(0, (multiple - 1) * 100)
  const usageBillableCents = practice.usageCostCents * multiple
  const feeCents = Math.max(0, feeDollars) * 100
  const blendedCents = usageBillableCents + feeCents
  const marginCents = blendedCents - practice.usageCostCents
  const reloadCents = Math.max(0, reloadDollars) * 100

  const dirty =
    Math.abs(markupPct - practice.currentMarkupPct) > 0.001 ||
    feeCents !== practice.currentFeeCents ||
    autocharge !== practice.autocharge ||
    prepaid !== practice.prepaid ||
    autoReload !== practice.autoReload ||
    reloadCents !== practice.reloadAmountCents

  async function save() {
    setSaving(true)
    setSaved(false)
    try {
      const res = await fetch('/api/agency/billing-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationId: practice.id,
          markupPct: Math.round(markupPct * 100) / 100,
          platformFeeCents: feeCents,
          autocharge,
          billingMode: prepaid ? 'prepaid' : 'invoice',
          autoReload,
          reloadAmountCents: reloadCents,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to save')
      }
      practice.currentMarkupPct = markupPct
      practice.currentFeeCents = feeCents
      practice.autocharge = autocharge
      practice.prepaid = prepaid
      practice.autoReload = autoReload
      practice.reloadAmountCents = reloadCents
      setSaved(true)
      toast.success(`Saved pricing for ${practice.name}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save pricing')
    } finally {
      setSaving(false)
    }
  }

  async function draftInvoice() {
    setIssuing(true)
    try {
      const res = await fetch('/api/agency/invoices/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: practice.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to draft invoice')
      toast.success(`Draft invoice for ${practice.name}: ${usd(data.invoice?.totalCents ?? 0)} — review in Invoices`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to draft invoice')
    } finally {
      setIssuing(false)
    }
  }

  async function setupCard() {
    setSettingUpCard(true)
    try {
      const res = await fetch('/api/agency/billing-settings/card-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: practice.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.url) throw new Error(data.error || 'Failed to start card setup')
      window.open(data.url, '_blank', 'noopener')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start card setup')
    } finally {
      setSettingUpCard(false)
    }
  }

  async function reloadNow() {
    setReloading(true)
    try {
      const res = await fetch('/api/agency/billing-settings/reload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: practice.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Reload failed')
      practice.balanceCents = data.balanceCents ?? practice.balanceCents
      toast.success(`Reloaded ${usd(data.amountCents ?? 0)} — balance ${usd(data.balanceCents ?? 0)}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Reload failed')
    } finally {
      setReloading(false)
    }
  }

  return (
    <div className="aurea-card flex flex-col gap-3 p-4 sm:py-3.5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-4">
      {/* Practice */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-aurea-surface-2 text-[10px] font-semibold text-aurea-ink-2 ring-1 ring-aurea-border">
          {initials(practice.name)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-medium text-aurea-ink">{practice.name}</p>
          <p className="mt-0.5 font-mono text-[10.5px] tabular-nums text-aurea-ink-3">
            {usd(practice.usageCostCents)} usage cost / mo{practice.hasOverride ? '' : ' · default pricing'}
          </p>
        </div>
      </div>

      {/* Markup multiple */}
      <label className="flex items-center justify-between gap-2 sm:w-24 sm:justify-end">
        <span className="text-[11px] text-aurea-ink-3 sm:hidden">Markup ×</span>
        <div className="relative">
          <input
            type="number"
            min={1}
            step={0.5}
            value={multiple}
            onChange={(e) => setMultiple(Number(e.target.value))}
            className="w-20 rounded-md border border-aurea-border bg-aurea-surface px-2 py-1.5 pr-5 text-right font-mono text-[13px] tabular-nums text-aurea-ink focus:border-aurea-primary focus:outline-none"
          />
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-aurea-ink-3">×</span>
        </div>
      </label>

      {/* Platform fee */}
      <label className="flex items-center justify-between gap-2 sm:w-28 sm:justify-end">
        <span className="text-[11px] text-aurea-ink-3 sm:hidden">Fee / mo</span>
        <div className="relative">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-aurea-ink-3">$</span>
          <input
            type="number"
            min={0}
            step={50}
            value={feeDollars}
            onChange={(e) => setFeeDollars(Number(e.target.value))}
            className="w-24 rounded-md border border-aurea-border bg-aurea-surface px-2 py-1.5 pl-5 text-right font-mono text-[13px] tabular-nums text-aurea-ink focus:border-aurea-primary focus:outline-none"
          />
        </div>
      </label>

      {/* Blended preview */}
      <div className="text-right sm:w-28">
        <p className="font-mono text-[15px] tabular-nums text-aurea-ink">{usd(blendedCents)}</p>
        <p className="font-mono text-[10px] tabular-nums text-aurea-primary">+{usd(marginCents)} margin</p>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 sm:w-40">
        <button
          type="button"
          onClick={draftInvoice}
          disabled={issuing}
          className="inline-flex items-center gap-1 text-[12px] font-medium text-aurea-ink-3 transition-colors hover:text-aurea-ink disabled:opacity-50"
          title="Create a draft invoice for the current month; review & send from Invoices"
        >
          {issuing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Bill month
        </button>
        <Button size="sm" variant={dirty ? 'default' : 'outline'} disabled={!dirty || saving} onClick={save} className="gap-1.5">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saved && !dirty ? <Check className="h-3.5 w-3.5" /> : null}
          {saved && !dirty ? 'Saved' : 'Save'}
        </Button>
      </div>
      </div>

      {/* Auto-charge + card on file */}
      <div className="flex items-center justify-between gap-3 border-t border-aurea-border/60 pt-3">
        <label className="flex items-center gap-2 text-[12px] text-aurea-ink-2">
          <input
            type="checkbox"
            checked={autocharge}
            onChange={(e) => setAutocharge(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-aurea-border accent-aurea-primary"
          />
          Auto-charge monthly
          {autocharge && !practice.hasCardOnFile && <span className="text-aurea-amber">· needs a card</span>}
        </label>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[11px] text-aurea-ink-3">
            {practice.hasCardOnFile ? 'Card on file' : 'No card on file'}
          </span>
          <button
            type="button"
            onClick={setupCard}
            disabled={settingUpCard}
            className="inline-flex items-center gap-1 text-[12px] font-medium text-aurea-ink-3 transition-colors hover:text-aurea-ink disabled:opacity-50"
          >
            {settingUpCard ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {practice.hasCardOnFile ? 'Update card' : 'Set up card'}
          </button>
        </div>
      </div>

      {/* Prepaid wallet + auto-reload */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-aurea-border/60 pt-3">
        <label className="flex items-center gap-2 text-[12px] text-aurea-ink-2">
          <input
            type="checkbox"
            checked={prepaid}
            onChange={(e) => setPrepaid(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-aurea-border accent-aurea-primary"
          />
          Prepaid wallet
        </label>
        {prepaid && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-2 text-[12px] text-aurea-ink-2">
              <input
                type="checkbox"
                checked={autoReload}
                onChange={(e) => setAutoReload(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-aurea-border accent-aurea-primary"
              />
              Auto-reload at 10% ({usd(reloadCents * 0.1)})
              {autoReload && !practice.hasCardOnFile && <span className="text-aurea-amber">· needs a card</span>}
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-aurea-ink-3">
              Reload
              <span className="relative">
                <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-aurea-ink-3">$</span>
                <input
                  type="number"
                  min={0}
                  step={50}
                  value={reloadDollars}
                  onChange={(e) => setReloadDollars(Number(e.target.value))}
                  className="w-24 rounded-md border border-aurea-border bg-aurea-surface px-2 py-1.5 pl-5 text-right font-mono text-[12px] tabular-nums text-aurea-ink focus:border-aurea-primary focus:outline-none"
                />
              </span>
            </label>
            <span className="font-mono text-[11px] text-aurea-ink-3">Balance {usd(practice.balanceCents)}</span>
            <button
              type="button"
              onClick={reloadNow}
              disabled={reloading}
              className="inline-flex items-center gap-1 text-[12px] font-medium text-aurea-ink-3 transition-colors hover:text-aurea-ink disabled:opacity-50"
            >
              {reloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Add funds
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
