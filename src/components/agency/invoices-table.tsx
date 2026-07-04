'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, Send, Check, Ban, CircleDollarSign } from 'lucide-react'

export type InvoiceRow = {
  id: string
  organization_id: string
  orgName: string
  period_start: string
  period_end: string
  usage_billable_cents: number
  platform_fee_cents: number
  total_cents: number
  status: string
  sent_at: string | null
}

const usd = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const monthLabel = (d: string) =>
  new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-aurea-surface-2 text-aurea-ink-2 ring-aurea-border',
  issued: 'bg-aurea-amber/10 text-aurea-amber ring-aurea-amber/20',
  paid: 'bg-aurea-primary/10 text-aurea-primary ring-aurea-primary/20',
  void: 'bg-aurea-rose/10 text-aurea-rose ring-aurea-rose/20',
}

export function InvoicesTable({ invoices }: { invoices: InvoiceRow[] }) {
  if (invoices.length === 0) {
    return (
      <p className="aurea-card px-6 py-16 text-center text-[13px] text-aurea-ink-3">
        No invoices yet. Draft one from the pricing calculator (&ldquo;Bill month&rdquo;).
      </p>
    )
  }
  return (
    <div className="aurea-card overflow-hidden">
      <div className="hidden items-center gap-4 border-b border-aurea-border px-5 py-3 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-aurea-ink-3 sm:flex">
        <span className="flex-1">Practice</span>
        <span className="w-24">Period</span>
        <span className="w-20 text-right">Total</span>
        <span className="w-20 text-center">Status</span>
        <span className="w-56 text-right">Actions</span>
      </div>
      {invoices.map((inv) => (
        <InvoiceRowView key={inv.id} inv={inv} />
      ))}
    </div>
  )
}

function InvoiceRowView({ inv }: { inv: InvoiceRow }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)

  async function act(kind: 'issue' | 'void' | 'mark_paid' | 'send') {
    setBusy(kind)
    try {
      const url = kind === 'send' ? `/api/agency/invoices/${inv.id}/send` : `/api/agency/invoices/${inv.id}`
      const res = await fetch(url, {
        method: kind === 'send' ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: kind === 'send' ? undefined : JSON.stringify({ action: kind }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Action failed')
      toast.success(
        kind === 'send' ? `Emailed to ${data.sentTo}` : kind === 'issue' ? 'Invoice issued' : kind === 'void' ? 'Invoice voided' : 'Marked paid',
      )
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  const spin = (k: string) => busy === k
  const disabled = busy !== null
  const canSend = inv.status !== 'void'

  return (
    <div className="flex flex-col gap-3 border-b border-aurea-border px-5 py-3.5 last:border-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-medium text-aurea-ink">{inv.orgName}</p>
        <p className="mt-0.5 font-mono text-[10.5px] tabular-nums text-aurea-ink-3">
          {usd(inv.usage_billable_cents)} usage + {usd(inv.platform_fee_cents)} fee
          {inv.sent_at ? ' · sent' : ''}
        </p>
      </div>
      <span className="font-mono text-[12px] tabular-nums text-aurea-ink-2 sm:w-24">{monthLabel(inv.period_start)}</span>
      <span className="font-mono text-[14px] tabular-nums text-aurea-ink sm:w-20 sm:text-right">{usd(inv.total_cents)}</span>
      <span className="sm:w-20 sm:text-center">
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium capitalize ring-1 ${STATUS_STYLE[inv.status] ?? STATUS_STYLE.draft}`}>
          {inv.status}
        </span>
      </span>
      <div className="flex items-center justify-end gap-3 sm:w-56">
        {inv.status === 'draft' && (
          <ActionButton label="Issue" busy={spin('issue')} disabled={disabled} onClick={() => act('issue')} />
        )}
        {canSend && (
          <ActionButton label="Send" icon={Send} busy={spin('send')} disabled={disabled} onClick={() => act('send')} />
        )}
        {inv.status === 'issued' && (
          <ActionButton label="Paid" icon={CircleDollarSign} busy={spin('mark_paid')} disabled={disabled} onClick={() => act('mark_paid')} />
        )}
        {inv.status !== 'void' && inv.status !== 'paid' && (
          <ActionButton label="Void" icon={Ban} busy={spin('void')} disabled={disabled} onClick={() => act('void')} danger />
        )}
        {inv.status === 'paid' && <Check className="h-4 w-4 text-aurea-primary" />}
      </div>
    </div>
  )
}

function ActionButton({
  label,
  icon: Icon,
  busy,
  disabled,
  onClick,
  danger,
}: {
  label: string
  icon?: typeof Send
  busy: boolean
  disabled: boolean
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1 text-[12px] font-medium transition-colors disabled:opacity-40 ${
        danger ? 'text-aurea-ink-3 hover:text-aurea-rose' : 'text-aurea-ink-3 hover:text-aurea-ink'
      }`}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : Icon ? <Icon className="h-3.5 w-3.5" /> : null}
      {label}
    </button>
  )
}
