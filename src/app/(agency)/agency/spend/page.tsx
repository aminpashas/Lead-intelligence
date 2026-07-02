import { createClient } from '@/lib/supabase/server'
import { loadAgencySpend, formatUsd, marginPct } from '@/lib/billing/spend-summary'
import { Bot, MessageSquare, Phone, Mail, ArrowRight } from 'lucide-react'
import Link from 'next/link'

export const metadata = {
  title: 'Spend & Margin | Lead Intelligence',
}

const RANGES = [7, 30, 90]

const SERVICES: { key: string; label: string; provider: string; icon: typeof Bot }[] = [
  { key: 'ai', label: 'AI', provider: 'Anthropic', icon: Bot },
  { key: 'sms', label: 'SMS', provider: 'Twilio', icon: MessageSquare },
  { key: 'voice', label: 'Voice', provider: 'Retell', icon: Phone },
  { key: 'email', label: 'Email', provider: 'Resend', icon: Mail },
]

function initialsOf(name: string) {
  return name.split(' ').map((w) => w[0]).filter(Boolean).join('').toUpperCase().slice(0, 2)
}

export default async function AgencySpendPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  const { days } = await searchParams
  const sinceDays = RANGES.includes(Number(days)) ? Number(days) : 30

  const supabase = await createClient()
  const { summary, orgNames } = await loadAgencySpend(supabase, { sinceDays })

  const kpis = [
    { index: '01', label: 'Provider Cost', value: formatUsd(summary.totalCostCents), sub: 'what we pay providers' },
    { index: '02', label: 'Billable', value: formatUsd(summary.totalBillableCents), sub: 're-billed to practices' },
    { index: '03', label: 'Margin', value: formatUsd(summary.marginCents), sub: 'billable − cost' },
    { index: '04', label: 'Margin', value: `${marginPct(summary).toFixed(1)}%`, sub: 'of billable' },
  ]

  const orgRows = Object.entries(summary.byOrg)
    .map(([id, t]) => ({
      id,
      name: orgNames[id] ?? 'Unknown practice',
      costCents: t.costCents,
      billableCents: t.billableCents,
      marginCents: t.billableCents - t.costCents,
    }))
    .sort((a, b) => b.billableCents - a.billableCents)

  const maxServiceBillable = Math.max(
    1,
    ...SERVICES.map((s) => summary.byService[s.key]?.billableCents ?? 0),
  )

  const activeServices = SERVICES.filter((s) => (summary.byService[s.key]?.costCents ?? 0) > 0 || s.key !== 'email')

  return (
    <div className="animate-in fade-in-0 duration-500">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="flex flex-col gap-5 border-b border-aurea-border pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="aurea-eyebrow mb-3">Cost Intelligence</p>
          <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[52px]">Spend &amp; Margin</h1>
          <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-aurea-ink-2">
            Blended cost across Anthropic, Twilio, and Retell — and what each practice is re-billed at
            cost plus markup. AI is computed from token usage; SMS &amp; voice reconcile to the provider&rsquo;s
            actual charge.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1 rounded-full border border-aurea-border p-1">
          {RANGES.map((r) => (
            <Link
              key={r}
              href={`/agency/spend?days=${r}`}
              className={`rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors ${
                r === sinceDays ? 'bg-aurea-ink text-aurea-surface' : 'text-aurea-ink-3 hover:text-aurea-ink'
              }`}
            >
              {r}d
            </Link>
          ))}
        </div>
      </header>

      {/* ── KPI grid ───────────────────────────────────────── */}
      <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((kpi) => (
          <div key={kpi.index} className="aurea-card p-5">
            <div className="flex items-center justify-between">
              <p className="aurea-eyebrow">{kpi.label}</p>
              <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">/{kpi.index}</span>
            </div>
            <p className="mt-4 aurea-display text-[36px] tabular-nums text-aurea-ink">{kpi.value}</p>
            <p className="mt-3 text-[11.5px] text-aurea-ink-3">{kpi.sub}</p>
          </div>
        ))}
      </div>

      {/* ── By service + By practice ───────────────────────── */}
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* By service */}
        <section className="aurea-card overflow-hidden">
          <div className="border-b border-aurea-border px-5 py-4">
            <h2 className="aurea-display text-[22px] text-aurea-ink">By Service</h2>
            <p className="mt-0.5 text-[12px] text-aurea-ink-3">Cost &amp; billable over the last {sinceDays} days</p>
          </div>
          <div className="px-5 py-2">
            {activeServices.map((s) => {
              const t = summary.byService[s.key] ?? { costCents: 0, billableCents: 0 }
              const width = Math.round(((t.billableCents ?? 0) / maxServiceBillable) * 100)
              return (
                <div key={s.key} className="border-b border-aurea-border py-4 last:border-0">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <s.icon className="h-[16px] w-[16px] text-aurea-ink-3" strokeWidth={1.75} />
                      <span className="text-[13.5px] font-medium text-aurea-ink">{s.label}</span>
                      <span className="font-mono text-[10px] uppercase tracking-wide text-aurea-ink-3">{s.provider}</span>
                    </div>
                    <div className="text-right">
                      <span className="font-mono text-[13px] tabular-nums text-aurea-ink">{formatUsd(t.billableCents)}</span>
                      <span className="ml-2 font-mono text-[11px] tabular-nums text-aurea-ink-3">/ {formatUsd(t.costCents)} cost</span>
                    </div>
                  </div>
                  <div className="mt-2.5 h-[3px] w-full overflow-hidden rounded-full bg-aurea-surface-2">
                    <div className="h-full rounded-full bg-aurea-primary" style={{ width: `${width}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {/* By practice */}
        <section className="aurea-card overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-aurea-border px-5 py-4">
            <div>
              <h2 className="aurea-display text-[22px] text-aurea-ink">By Practice</h2>
              <p className="mt-0.5 text-[12px] text-aurea-ink-3">Cost, billable &amp; margin per practice</p>
            </div>
            <Link
              href="/agency/practices"
              className="group inline-flex items-center gap-1.5 text-[12px] font-medium text-aurea-ink-2 transition-colors hover:text-aurea-ink"
            >
              Practices
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
          <div className="px-5">
            {orgRows.length > 0 ? (
              orgRows.slice(0, 8).map((o) => (
                <div key={o.id} className="flex items-center justify-between gap-3 border-b border-aurea-border py-3.5 last:border-0">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-aurea-surface-2 text-[10px] font-semibold text-aurea-ink-2 ring-1 ring-aurea-border">
                      {initialsOf(o.name)}
                    </span>
                    <p className="truncate text-[13.5px] font-medium text-aurea-ink">{o.name}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-4 text-right">
                    <span className="hidden font-mono text-[11px] tabular-nums text-aurea-ink-3 sm:inline">{formatUsd(o.costCents)}</span>
                    <span className="font-mono text-[13px] tabular-nums text-aurea-ink">{formatUsd(o.billableCents)}</span>
                    <span className="w-16 font-mono text-[12px] tabular-nums text-aurea-primary">+{formatUsd(o.marginCents)}</span>
                  </div>
                </div>
              ))
            ) : (
              <p className="py-10 text-center text-[13px] text-aurea-ink-3">No spend recorded in this window yet.</p>
            )}
          </div>
        </section>
      </div>

      {/* ── Footnote ───────────────────────────────────────── */}
      <p className="mt-8 max-w-3xl text-[11.5px] leading-relaxed text-aurea-ink-3">
        Figures are for in-app tracking. AI cost is computed from Anthropic token usage; SMS is
        estimated at send and reconciled to Twilio&rsquo;s billed price; voice reflects Retell&rsquo;s reported
        cost. Billable applies each practice&rsquo;s markup (Spend → Billing settings). Reconcile against the
        provider invoices of record.
      </p>
    </div>
  )
}
