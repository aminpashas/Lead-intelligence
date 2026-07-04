import { createClient } from '@/lib/supabase/server'
import { formatUsd } from '@/lib/billing/spend-summary'
import { loadLiveSpend, type UsageQuantities } from '@/lib/billing/usage-live'
import { DEFAULT_MARKUP_PCT, DEFAULT_PLATFORM_FEE_CENTS } from '@/lib/billing/markup'
import { Bot, MessageSquare, Phone, Mail, ArrowRight } from 'lucide-react'
import Link from 'next/link'

export const metadata = {
  title: 'Spend & Margin | Lead Intelligence',
}

const RANGES = [7, 30, 90]

const SERVICES: { key: 'ai' | 'sms' | 'voice' | 'email'; label: string; provider: string; icon: typeof Bot }[] = [
  { key: 'ai', label: 'AI', provider: 'Anthropic', icon: Bot },
  { key: 'sms', label: 'SMS', provider: 'Twilio', icon: MessageSquare },
  { key: 'voice', label: 'Voice', provider: 'Retell', icon: Phone },
  { key: 'email', label: 'Email', provider: 'Resend', icon: Mail },
]

function initialsOf(name: string) {
  return name.split(' ').map((w) => w[0]).filter(Boolean).join('').toUpperCase().slice(0, 2)
}

/** Effective multiple of cost actually billed (billable ÷ cost). Falls back to the policy default. */
function effectiveMultiple(costCents: number, billableCents: number): number {
  if (costCents > 0) return billableCents / costCents
  return 1 + DEFAULT_MARKUP_PCT.sms / 100
}

/** Human blurb of what each service's volume was, for the By Service rows. */
function volumeLabel(key: string, q: UsageQuantities): string {
  if (key === 'sms') return `${q.smsOutSegments.toLocaleString()} seg out · ${q.smsInCount.toLocaleString()} in`
  if (key === 'voice') return `${Math.round(q.voiceSeconds / 60).toLocaleString()} min · ${q.voiceCalls.toLocaleString()} calls`
  if (key === 'ai') return `${q.aiCalls.toLocaleString()} actions · ${(q.aiTokensIn + q.aiTokensOut).toLocaleString()} tok`
  if (key === 'email') return `${q.emailOutCount.toLocaleString()} sent`
  return ''
}

export default async function AgencySpendPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  const { days } = await searchParams
  const sinceDays = RANGES.includes(Number(days)) ? Number(days) : 30

  const supabase = await createClient()
  const { summary, byOrg, orgNames, totalPlatformFeeCents, totalBlendedCents } = await loadLiveSpend(supabase, { sinceDays })

  // Platform-wide usage quantities (sum across practices) for the By Service volume blurbs.
  const totalQ: UsageQuantities = {
    smsOutCount: 0, smsOutSegments: 0, smsInCount: 0, emailOutCount: 0,
    voiceSeconds: 0, voiceCalls: 0, aiCalls: 0, aiTokensIn: 0, aiTokensOut: 0, aiCostCents: 0,
  }
  for (const org of Object.values(byOrg)) {
    for (const k of Object.keys(totalQ) as (keyof UsageQuantities)[]) totalQ[k] += org.quantities[k]
  }

  const blendedMarginCents = totalBlendedCents - summary.totalCostCents
  const blendedMarginPct = totalBlendedCents > 0 ? (blendedMarginCents / totalBlendedCents) * 100 : 0

  const kpis = [
    { index: '01', label: 'Provider Cost', value: formatUsd(summary.totalCostCents), sub: 'what we pay providers' },
    { index: '02', label: 'Blended Revenue', value: formatUsd(totalBlendedCents), sub: 'usage + platform fees' },
    { index: '03', label: 'Margin', value: formatUsd(blendedMarginCents), sub: 'revenue − cost' },
    { index: '04', label: 'Margin', value: `${blendedMarginPct.toFixed(1)}%`, sub: 'of revenue' },
  ]

  const orgRows = Object.values(byOrg)
    .map((o) => ({
      id: o.organizationId,
      name: orgNames[o.organizationId] ?? 'Unknown practice',
      costCents: o.costCents,
      billableCents: o.billableCents,
      platformFeeCents: o.platformFeeCents,
      blendedCents: o.blendedCents,
      marginCents: o.blendedCents - o.costCents,
      multiple: effectiveMultiple(o.costCents, o.billableCents),
    }))
    .sort((a, b) => b.blendedCents - a.blendedCents)

  const maxServiceBillable = Math.max(
    1,
    ...SERVICES.map((s) => summary.byService[s.key]?.billableCents ?? 0),
  )

  const activeServices = SERVICES.filter((s) => (summary.byService[s.key]?.costCents ?? 0) > 0 || s.key !== 'email')

  // House re-bill policy (all services share the default today; overrides live in billing_settings).
  const policyMultiple = 1 + DEFAULT_MARKUP_PCT.sms / 100

  return (
    <div className="animate-in fade-in-0 duration-500">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="flex flex-col gap-5 border-b border-aurea-border pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="aurea-eyebrow mb-3">Cost Intelligence</p>
          <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[52px]">Spend &amp; Margin</h1>
          <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-aurea-ink-2">
            Blended provider cost across Anthropic, Twilio, Retell &amp; Resend — computed live from
            real usage — and what each practice is re-billed at cost plus markup.
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

      {/* ── Pricing policy strip ───────────────────────────── */}
      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-aurea-border bg-aurea-surface-2/40 px-5 py-3.5">
        <span className="aurea-eyebrow">Pricing policy</span>
        <span className="text-[13px] text-aurea-ink-2">
          <span className="font-semibold text-aurea-ink">{policyMultiple.toFixed(1)}× cost</span>
          <span className="text-aurea-ink-3"> ({DEFAULT_MARKUP_PCT.sms}% markup)</span> + {formatUsd(DEFAULT_PLATFORM_FEE_CENTS)}/mo platform fee
        </span>
        <span className="hidden text-[12px] text-aurea-ink-3 sm:inline">
          Usage {formatUsd(summary.totalBillableCents)} + fees {formatUsd(totalPlatformFeeCents)} = {formatUsd(totalBlendedCents)}
        </span>
        <Link
          href="/agency/pricing"
          className="group ml-auto inline-flex items-center gap-1.5 text-[12px] font-medium text-aurea-ink-2 transition-colors hover:text-aurea-ink"
        >
          Pricing calculator
          <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>

      {/* ── KPI grid ───────────────────────────────────────── */}
      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
            <p className="mt-0.5 text-[12px] text-aurea-ink-3">Cost, billable &amp; volume over the last {sinceDays} days</p>
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
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <div className="h-[3px] w-full max-w-[60%] overflow-hidden rounded-full bg-aurea-surface-2">
                      <div className="h-full rounded-full bg-aurea-primary" style={{ width: `${width}%` }} />
                    </div>
                    <span className="font-mono text-[10.5px] tabular-nums text-aurea-ink-3">{volumeLabel(s.key, totalQ)}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {/* By practice — how each account is charged */}
        <section className="aurea-card overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-aurea-border px-5 py-4">
            <div>
              <h2 className="aurea-display text-[22px] text-aurea-ink">By Practice</h2>
              <p className="mt-0.5 text-[12px] text-aurea-ink-3">Blended bill = usage re-bill + platform fee</p>
            </div>
            <Link
              href="/agency/pricing"
              className="group inline-flex items-center gap-1.5 text-[12px] font-medium text-aurea-ink-2 transition-colors hover:text-aurea-ink"
            >
              Adjust pricing
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
                    <div className="min-w-0">
                      <p className="truncate text-[13.5px] font-medium text-aurea-ink">{o.name}</p>
                      <p className="mt-0.5 font-mono text-[10.5px] tabular-nums text-aurea-ink-3">
                        {formatUsd(o.billableCents)} usage · {formatUsd(o.platformFeeCents)} fee · {o.multiple.toFixed(1)}×
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-4 text-right">
                    <span className="hidden font-mono text-[11px] tabular-nums text-aurea-ink-3 sm:inline">{formatUsd(o.costCents)} cost</span>
                    <span className="font-mono text-[14px] tabular-nums text-aurea-ink">{formatUsd(o.blendedCents)}</span>
                    <span className="w-16 font-mono text-[12px] tabular-nums text-aurea-primary">+{formatUsd(o.marginCents)}</span>
                  </div>
                </div>
              ))
            ) : (
              <p className="py-10 text-center text-[13px] text-aurea-ink-3">No usage in this window yet.</p>
            )}
          </div>
        </section>
      </div>

      {/* ── Footnote ───────────────────────────────────────── */}
      <p className="mt-8 max-w-3xl text-[11.5px] leading-relaxed text-aurea-ink-3">
        Computed live from usage: AI from Anthropic token cost (ai_usage); SMS at ~1.1¢/segment
        (Twilio A2P) over outbound segments + inbound; voice at ~8¢/min (Retell); email at the Resend
        blended rate. Billable applies each practice&rsquo;s markup — default {policyMultiple.toFixed(1)}× cost.
        These are in-app estimates; reconcile against the provider invoices of record.
      </p>
    </div>
  )
}
